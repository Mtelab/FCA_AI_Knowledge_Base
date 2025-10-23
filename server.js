import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/chat", async (req, res) => {
  try {
    const messages = req.body.messages || [];
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });
    res.json({ reply: completion.choices[0].message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error communicating with OpenAI API." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));

