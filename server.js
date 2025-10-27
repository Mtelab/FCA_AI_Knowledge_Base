import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
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
              model: "gpt-5-mini", // you can use gpt-5-mini later once verified
              messages: [
                {
                  role: "system",
                  content:
                    "Extract all staff names and roles from this FCA document. Format as 'Name – Title'. Keep it factual and concise."
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

// 📅 Load all Google Calendars (from .ics URLs)
async function loadAllCalendars() {
  calendarText = "";
  const now = new Date(); // current time
  const oneYearAhead = new Date();
  oneYearAhead.setFullYear(now.getFullYear() + 1); // optional: limit to next 12 months

  for (const url of calendarURLs) {
    try {
      console.log(`🔄 Fetching calendar: ${url}`);
      const data = await ical.async.fromURL(url);
      const events = Object.values(data).filter(
        (e) =>
          e.type === "VEVENT" &&
          e.start instanceof Date &&
          e.start >= now && // ✅ only future events
          e.start <= oneYearAhead // optional upper bound
      );

      for (const event of events) {
        const start = event.start.toLocaleString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        const end = event.end
          ? event.end.toLocaleString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";
        calendarText += `\n📅 Event: ${event.summary}\n🕒 Date: ${start}${
          end ? " - " + end : ""
        }\n📍 Location: ${event.location || "TBA"}\n📝 Description: ${
          event.description || ""
        }\n---\n`;
      }
    } catch (err) {
      console.warn(`⚠️ Error loading calendar ${url}: ${err.message}`);
    }
  }

  console.log(
    `✅ Loaded ${calendarURLs.length} calendar(s) with upcoming events only.`
  );
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
    const lastUserMessage =
      userMessages[userMessages.length - 1]?.content || "";

    const systemPrompt = {
      role: "system",
      content:
        "You are FCA Assistant, an AI trained to answer questions about Faith Christian Academy using the following official documents:\n" +
        fcaKnowledge +
        "\nIf the question cannot be answered using these materials, respond ONLY with this text: [NEEDS_WEBSITE_SEARCH].",
    };

    // ask OpenAI for a reply
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemPrompt, ...userMessages],
    });

    let reply = completion.choices[0]?.message?.content?.trim() || "";

    // 📧 Staff email shortcut
    if (
      /email/i.test(lastUserMessage) &&
      /\b(staff|teacher|faculty|coach|mr|mrs|ms)\b/i.test(lastUserMessage)
    ) {
      const nameMatch = lastUserMessage.match(/([A-Z][a-z]+)\s+([A-Z][a-z]+)/);
      if (nameMatch) {
        const first = nameMatch[1].toLowerCase();
        const last = nameMatch[2].toLowerCase();
        const email = `${first}.${last}@faithchristianacademy.net`;
        reply = `The email address for ${nameMatch[1]} ${nameMatch[2]} is likely **${email}**.`;
      } else {
        reply =
          "If you can tell me the first and last name, I can give you their email address (format: FirstName.LastName@faithchristianacademy.net).";
      }
    }

    // send reply to frontend
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














