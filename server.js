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
        fcaKnowledge += `\n--- ${file} ---\n${pdfData.text}\n`;
      }
    }
    console.log(`✅ Loaded ${files.length} FCA PDF files.`);
  } catch (err) {
    console.error("⚠️ Error loading PDF files:", err);
  }
}

// 📅 Load all Google Calendars (from .ics URLs)
import ical from "node-ical"; // make sure this is imported at the top

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

// 💬 Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];

    const context =
      fcaKnowledge +
      (calendarText
        ? "\n--- Google Calendar Events ---\n" + calendarText
        : "");

    const systemPrompt = {
      role: "system",
      content:
        "You are FCA Assistant, an AI trained to answer questions about Faith Christian Academy using the following official documents and event calendars:\n" +
        context +
        "\nIf the question cannot be answered using these materials, politely tell the user to visit the official Faith Christian Academy website (https://www.faithchristianacademy.net). Do not invent answers.",
    };

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [systemPrompt, ...userMessages],
    });

    res.json({ reply: completion.choices[0].message });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: "Error communicating with OpenAI API." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`✅ FCA Assistant running on port ${port}`)
);









