import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";  // 👈 Add this
import { fileURLToPath } from "url";

// Show branded loading message until backend responds
window.addEventListener("load", async () => {
  const loadingEl = document.getElementById("loading");
  try {
    const res = await fetch("/");
    if (res.ok) {
      loadingEl.style.display = "none"; // Hide when server is ready
    }
  } catch {
    // If still waking up, keep showing "Starting FCA Assistant..."
    console.log("Backend still starting up...");
  }
});

dotenv.config();
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 🧠 Load FCA Knowledge Base PDFs automatically
const dataDir = path.join(__dirname, "data");
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

// 💬 Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];
    const systemPrompt = {
      role: "system",
      content:
        "You are FCA Assistant, an AI trained to answer questions about Faith Christian Academy using the following official documents:\n" +
        fcaKnowledge +
        "\nIf the question is not answered by these materials, respond that the user should refer to the official Faith Christian Academy website (faithchristianacademy.net)."
    };

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemPrompt, ...userMessages],
    });

    res.json({ reply: completion.choices[0].message });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: "Error communicating with OpenAI API." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ FCA Assistant running on port ${port}`));
