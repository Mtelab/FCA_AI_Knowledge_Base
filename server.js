import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import puppeteer from "puppeteer"; // ✅ NEW
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

// 🌐 Smart FCA website crawler using Puppeteer
async function searchFCAWebsite(query) {
  const baseUrl = "https://www.faithchristianacademy.net";
  const visited = new Set();
  const toVisit = [baseUrl];
  const q = query.toLowerCase();
  const maxPages = 20; // safety limit

  async function fetchPage(url) {
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
      );

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const text = await page.evaluate(() => document.body.innerText);
      const lower = text.toLowerCase();

      // ✅ Found match
      if (lower.includes(q)) {
        const start = lower.indexOf(q);
        const snippet = text.substring(Math.max(0, start - 150), start + 400);
        await browser.close();
        return { found: true, snippet: snippet.trim(), url };
      }

      // 🕸️ Collect new internal links
      const links = await page.$$eval("a[href]", (as) =>
        as.map((a) => a.href).filter((h) => h && h.startsWith("https://www.faithchristianacademy.net"))
      );

      links.forEach((nextUrl) => {
        if (
          !visited.has(nextUrl) &&
          !nextUrl.endsWith(".pdf") &&
          !nextUrl.includes("mailto")
        ) {
          toVisit.push(nextUrl);
        }
      });

      await browser.close();
      return { found: false };
    } catch (err) {
      console.warn(`⚠️ Puppeteer error at ${url}: ${err.message}`);
      if (browser) await browser.close().catch(() => {});
      return { found: false };
    }
  }

  // Crawl and search pages until a match is found
  while (toVisit.length && visited.size < maxPages) {
    const url = toVisit.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);
    const result = await fetchPage(url);
    if (result.found) {
      return `🌐 Found on the FCA website (${result.url}):\n\n${result.snippet}`;
    }
  }

  return null;
}

// ✅ Root route to confirm backend is ready
app.get("/", (req, res) => {
  res.status(200).send("✅ FCA Assistant backend is running.");
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
        "\nIf the question cannot be answered using these materials, respond ONLY with this text: [NEEDS_WEBSITE_SEARCH].",
    };

    // Step 1️⃣: Ask OpenAI to search documents
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemPrompt, ...userMessages],
    });

    let reply = completion.choices[0].message.content.trim();

    // Step 2️⃣: If model signals to use website search, trigger Puppeteer
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
app.listen(port, () =>
  console.log(`✅ FCA Assistant running on port ${port}`)
);
