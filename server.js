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

// 💡 NEW HELPER FUNCTION TO SEARCH CONTEXT
/**
 * Searches the message history for the most recently mentioned full name.
 * @param {Array} messages - The conversation message history.
 * @returns {Array|null} - An array [FirstName, LastName] or null.
 */
function findContextualName(messages) {
    // Regex to find two capitalized words separated by a space (e.g., "Jeffrey Baker")
    const namePattern = /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g; 
    
    // Titles to ignore when extracted from the document
    const junkWords = new Set(["Mr", "Mrs", "Ms", "Miss", "Dr", "Teacher", "Pastor", "Principal", "Coach"]);

    // Iterate backward from the second-to-last message (0-index)
    for (let i = messages.length - 2; i >= 0; i--) {
        const content = messages[i]?.content || "";
        
        // Find all two-word names in the message
        let match;
        while ((match = namePattern.exec(content)) !== null) {
            const firstName = match[1];
            const lastName = match[2];
            
            // Validate the first word is not a title
            if (!junkWords.has(firstName)) {
                // Return the most recently found valid full name
                return [firstName, lastName];
            }
        }
    }
    return null; // No valid name found in context
}

app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";

    // 📧 Email shortcut logic
    if (/email/i.test(lastUserMessage)) {
      // Set of junk words in both lowercase and capitalized form for filtering
      const junkWords = new Set([
        // Lowercase versions (used for filtering user input)
        "what", "is", "email", "address", "the", "for", "please", "give", "me", "of", "do", "you", "know",
        "tell", "can", "someone", "send", "need", "get", "find", "contact", "info", "a", 
        "mr", "mrs", "ms", "miss", "dr", "teacher", "pastor", "principal", "coach", 
        // Capitalized versions (used for filtering extracted names from document content)
        "Mr", "Mrs", "Ms", "Miss", "Dr", "Teacher", "Pastor", "Principal", "Coach"
      ]);
      
      let first = "", last = "";
      
      // 🛑 NEW: Step 1: Check conversation history for a context name
      const contextName = findContextualName(userMessages);
      if (contextName) {
          [first, last] = contextName;
      } else {
          // Step 2: Fallback to cleaning the last message (original logic)
          const rawWords = lastUserMessage.split(/[^a-zA-Z]+/).filter(w => w);
          const words = rawWords.filter(w => !junkWords.has(w) && !junkWords.has(w.toLowerCase()));
          
          if (words.length >= 2) {
            // Found two likely names (e.g., "John Smith")
            [first, last] = words.slice(0, 2);

          } else if (words.length === 1) {
            // Found one word (e.g., "Hobbs")
            const singleWord = words[0];
            
            // Check if this single word exists in the documents
            const knowledgeSearchPattern = new RegExp(`\\b${singleWord}\\b`, 'i');

            if (knowledgeSearchPattern.test(fcaKnowledge)) {
              const presumedLastName = capitalize(singleWord);
              
              // 🚀 ADVANCED LOGIC: Try to find the first name in the FCA Knowledge
              const fullMatchRegex = new RegExp(`\\b([A-Z][a-z]+)\\s+${presumedLastName}\\b`, 'g');
              const allMatches = Array.from(fcaKnowledge.matchAll(fullMatchRegex));
              
              let foundFirstName = null;

              for (const match of allMatches) {
                  const potentialFirstName = match[1];
                  
                  // If the extracted word is NOT a capitalized title, use it.
                  if (!junkWords.has(potentialFirstName)) {
                      foundFirstName = potentialFirstName;
                      break; 
                  }
              }
              
              if (foundFirstName) {
                // Success! We found a real first name in the document
                first = foundFirstName;
                last = presumedLastName;
              } else {
                // Fallback: Last name confirmed, but no valid, non-title first name found
                const emailFormat = `FirstName.${presumedLastName.toLowerCase()}@faithchristianacademy.net`;
                return res.json({
                  reply: {
                    role: "assistant",
                    content: `I found a reference to **${presumedLastName}** in the FCA documents but couldn't confirm the first name. The email format for them is **${emailFormat}**. You will need to replace 'FirstName' with their actual first name.`,
                  },
                });
              }
            }
          }
      }

      // Step 3: If a first and last name was successfully found via context OR direct parsing
      if (first && last) {
        // Ensure names are properly cased for the display name
        const displayName = `${capitalize(first)} ${capitalize(last)}`;
        // Ensure names are lowercased for the email address
        const email = `${first.toLowerCase()}.${last.toLowerCase()}@faithchristianacademy.net`;
        
        return res.json({
          reply: {
            role: "assistant",
            content: `The email address for ${displayName} is likely **${email}**.`,
          },
        });
      }

      // Step 4: Final fallback (no name found in context, message, or documents)
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
