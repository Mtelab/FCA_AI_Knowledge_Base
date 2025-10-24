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
async function loadAllCalendars() {
  try {
    calendarText = "";
    for (const url of calendarURLs) {
      console.log(`🔄 Fetching calendar: ${url}`);
      const data = await ical.async.fromURL(url);
      const events = Object.values(data).filter((e) => e.type === "VEVENT");
      for (const event of events) {
        calendarText += `\nEvent: ${event.summary}\nDate: ${event.start}\nDescription: ${
          event.description || ""
        }\nLocation: ${event.location || ""}\n---\n`;
      }
    }
    console.log(`✅ Loaded ${calendarURLs.length} calendar(s) with combined events.`);
  } catch (err) {
    console.error("⚠️ Error loading calendars:", err);
  }
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
      model: "gpt-4.1-mini",
      messages: [systemPrompt, ...userMessages],
      stream: true,
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






