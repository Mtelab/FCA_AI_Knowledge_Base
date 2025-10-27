import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { DateTime } from "luxon";
import ical from "node-ical";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

dotenv.config();
const app = express();
// NOTE: Use 'gpt-4o-mini' or 'gpt-3.5-turbo' for cost and speed for summarization
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); 
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 🧠 FCA Knowledge (PDFs + Calendar)
const dataDir = path.resolve("./data");
let fcaKnowledge = "";
let calendarURLs = [];
let calendarText = "";

// Helper Function: Defined globally
function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// 📘 Load PDFs from /data
async function loadPDFs() {
  try {
    const files = fs.readdirSync(dataDir);
    for (const file of files) {
      if (file.toLowerCase().endsWith(".pdf")) {
        const dataBuffer = fs.readFileSync(path.join(dataDir, file));
        const pdfData = await pdfParse(dataBuffer);
        let text = pdfData.text.trim();

        // 🧠 Check if it looks like a staff/personnel file
        const isStaffDoc =
          file.toLowerCase().includes("support") ||
          file.toLowerCase().includes("staff") ||
          file.toLowerCase().includes("personnel") ||
          file.toLowerCase().includes("faculty") ||
          file.toLowerCase().includes("administration");

        if (isStaffDoc && text.length > 0) {
          console.log(`🧠 Summarizing ${file} for clearer staff listings...`);
          try {
            const summary = await openai.chat.completions.create({
              model: "gpt-4o-mini", 
              messages: [
                {
                  role: "system",
                  content:
                    "Extract all staff names and roles from this FCA document. Format as 'Name – Title'. Keep it factual and concise. Each name should start with a capital letter (e.g., John Smith – Teacher)."
                },
                { role: "user", content: text.slice(0, 15000) }
              ]
            });

            const cleaned = summary.choices?.[0]?.message?.content?.trim();
            if (cleaned) {
              fcaKnowledge += `\n--- ${file} (summarized) ---\n${cleaned}\n`;
            } else {
              fcaKnowledge += `\n--- ${file} ---\n${text}\n`;
            }
          } catch (err) {
            console.warn(`⚠️ Could not summarize ${file}:`, err.message);
            fcaKnowledge += `\n--- ${file} ---\n${text}\n`;
          }
        } else {
          // Normal PDF append
          fcaKnowledge += `\n--- ${file} ---\n${text}\n`;
        }
      }
    }

    console.log("✅ Loaded and processed all FCA PDF files.");
  } catch (err) {
    console.error("⚠️ Error loading PDF files:", err);
  }
}

// 🗓️ Load Google Calendar URLs from environment variable
async function loadAllCalendars() {
  if (!process.env.CALENDAR_URLS) return;

  const urls = process.env.CALENDAR_URLS.split(",").map(u => u.trim());
  const now = DateTime.now().setZone("America/New_York");
  let combined = "";

  for (const url of urls) {
    try {
      const res = await fetch(url);
      const data = await res.text();
      const events = ical.parseICS(data);

      for (const k in events) {
        const ev = events[k];
        if (ev.type !== "VEVENT") continue;

        // 🕒 Convert to proper Eastern Time
        const start = DateTime.fromJSDate(ev.start, { zone: "utc" })
          .setZone("America/New_York");
        const end = DateTime.fromJSDate(ev.end, { zone: "utc" })
          .setZone("America/New_York");

        // 📅 Skip events more than 1 day in the past
        if (end < now.minus({ days: 1 })) continue;

        const timeStr = `${start.toFormat("cccc, LLLL d")} from ${start.toFormat("h:mm a")} to ${end.toFormat("h:mm a")}`;
        const location = ev.location ? ` at ${ev.location}` : "";
        combined += `\n${ev.summary} — ${timeStr}${location}`;
      }
    } catch (err) {
      console.warn("⚠️ Calendar load failed:", url, err.message);
    }
  }

  calendarText = combined || "No upcoming events found.";
  console.log("✅ Calendars loaded with timezone correction and future-event filtering.");
}

// 🚀 Initial load of PDFs
await loadPDFs();

// 🚀 Load calendar URLs from Render environment variable if provided
if (process.env.CALENDAR_URLS) {
  calendarURLs = process.env.CALENDAR_URLS.split(",").map((u) => u.trim());
  await loadAllCalendars();
}

// ✅ Root route
app.get("/", (req, res) => {
  res.status(200).send("✅ FCA Assistant backend is running.");
});

app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";

    // 📧 Email shortcut logic
    if (/email/i.test(lastUserMessage)) {
      const junkWords = new Set([
        "what", "is", "email", "address", "the", "for", "please", "give", "me", "of", "do", "you", "know",
        "tell", "can", "someone", "send", "need", "get", "find", "contact", "info", "a", "mr", "mrs", "ms",
        "miss", "coach", "dr", "teacher", "pastor", "principal" 
      ]);

      // Step 1: Clean the message to extract potential name words
      const words = lastUserMessage.toLowerCase().split(/[^a-z]+/).filter(w => w && !junkWords.has(w));
      let first = "", last = "";
      
      // Step 2: Attempt to extract a first and last name from the message itself
      if (words.length >= 2) {
        // Found two words (e.g., "John Smith")
        [first, last] = words.slice(0, 2);

      } else if (words.length === 1) {
        // Found one word (e.g., "Fields")
        const singleWord = words[0];
        
        // Note: Using a case-insensitive, whole-word-boundary regex for safer matching
        const knowledgeSearchPattern = new RegExp(`\\b${singleWord}\\b`, 'i');

        if (knowledgeSearchPattern.test(fcaKnowledge)) {
          const presumedLastName = capitalize(singleWord);
          
          // 🚀 ADVANCED LOGIC: Try to find the first name in the FCA Knowledge
          // We look for any word starting with a capital letter followed by the presumed last name.
          // This relies on the summary step providing names like "John Smith"
          const fullMatchRegex = new RegExp(`\\b([A-Z][a-z]+)\\s+${presumedLastName}\\b`, 'i');
          const fullMatch = fcaKnowledge.match(fullMatchRegex);
          
          if (fullMatch && fullMatch[1]) {
            // Success! We found a likely first name in the document
            first = fullMatch[1];
            last = presumedLastName;
            
            const email = `${first.toLowerCase()}.${last.toLowerCase()}@faithchristianacademy.net`;
            const displayName = `${capitalize(first)} ${capitalize(last)}`;
            
            return res.json({
                reply: {
                    role: "assistant",
                    content: `Based on the documents, the name is likely **${displayName}**. The email address is **${email}**.`,
                },
            });
          } else {
            // Fallback: If the last name is confirmed but the first name couldn't be extracted
            const emailFormat = `FirstName.${presumedLastName.toLowerCase()}@faithchristianacademy.net`;
            return res.json({
              reply: {
                role: "assistant",
                content: `I found a reference to **${presumedLastName}** in the FCA documents. The email format for them is **${emailFormat}**. You will need to replace 'FirstName' with their actual first name.`,
              },
            });
          }
        }
        // If single word is NOT found in knowledge, it falls through to the generic fallback.
      }

      // Step 3: If a first and last name were successfully extracted from the message (Step 2)
      if (first && last) {
        const email = `${first.toLowerCase()}.${last.toLowerCase()}@faithchristianacademy.net`;
        const displayName = `${capitalize(first)} ${capitalize(last)}`;

        return res.json({
          reply: {
            role: "assistant",
            content: `The email address for ${displayName} is likely **${email}**.`,
          },
        });
      }

      // Step 4: Final fallback if no name was parsable and no single name was found in knowledge
      return res.json({
        reply: {
          role: "assistant",
          content:
            "If you can tell me the first and last name, I can give you their email address (format: FirstName.LastName@faithchristianacademy.net).",
        },
      });
    }

    // 🧠 Otherwise, continue to OpenAI for normal FCA Q&A
    const systemPrompt = {
      role: "system",
      content:
        "You are FCA Assistant, an AI trained to answer questions about Faith Christian Academy using the following information:\n\n" +
        "📚 FCA Documents:\n" +
        fcaKnowledge +
        "\n\n📅 Calendar Events:\n" +
        calendarText +
        "\n\nIf the question cannot be answered using these materials, respond ONLY with this text: [NEEDS_WEBSITE_SEARCH].",
    };

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemPrompt, ...userMessages],
    });

    let reply = completion.choices[0]?.message?.content?.trim() || "";

    res.json({ reply: { role: "assistant", content: reply } });
  } catch (err) {
    console.error("❌ Error in /chat route:", err);
    res
      .status(500)
      .json({ error: "Server error: check console for stack trace." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`✅ FCA Assistant running on port ${port}`)
);
