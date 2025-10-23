import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import axios from "axios";
import cheerio from "cheerio";
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

// 🧠 Load FCA Knowledge Base PDFs automatically
const dataDir = path.resolve("./data");
let fcaKnowledge = "";

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

// Load PDFs at startup
await loadPDFs();

// 🌐 Helper: Search FCA website if needed
async function searchFCAWebsite(query) {
  try {
    const res = await axios.get("https://www.faithchristianacademy.net");
    const $ = cheerio.load(res.data);
    const text = $("body").text().replace(/\s+/g, " ");
    const lower = text.toLowerCase();
    const q = query.toLowerCase();

    if (lower.includes(q)) {
      const start = lower.indexOf(q);
      const snippet = text.substring(Math.max(0, start - 120), start + 300);
      return `🌐 Found on the official FCA website:\n\n${snippet.trim()}`;
    }
  } catch (err) {
    console.error("Website search error:", err.message);
  }
  return null;
}

// ✅ Root route to confirm backend is ready
app.get("/", (req, res) => {
  res.status(200).send("FCA Assistant backend is running.");
});

// 💬 Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";

    const systemPrompt = {
      role: "system",
      content:
        "You are FCA Assistant, an AI trained to answer questions about Faith Christian Academy using the following official documents:\n" +
        fcaKnowledge +
        "\nIf the question cannot be answered using these materials, respond with exactly this phrase: [NEEDS_WEBSITE_SEARCH].",
    };

    // Step 1️⃣ Ask OpenAI to find answer from local documents
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemPrompt, ...userMessages],
    });

    let reply = completion.choices[0].message.content.trim();

    // Step 2️⃣ If AI says it needs a website search, perform it automatically
    if (reply.includes("[NEEDS_WEBSITE_SEARCH]")) {
      const webResult = await searchFCAWebsite(lastUserMessage);
      reply =
        webResult ||
        "❌ Sorry, I couldn’t find that information in the FCA documents or on the website.";
    }

    res.json({ reply: { role: "assistant", content: reply } });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: "Error communicating with OpenAI API." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ FCA Assistant running on port ${port}`));
