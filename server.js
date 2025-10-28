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

// Fix: Correctly define __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url)); 
const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN || "defaultdomain.net"; // Configurable domain

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

// 📘 Load PDFs from /data (unchanged)
async function loadPDFs() {
  // ... (unchanged PDF loading and summarizing logic) ...
  try {
    const files = fs.readdirSync(dataDir);
    for (const file of files) {
      if (file.toLowerCase().endsWith(".pdf")) {
        const dataBuffer = fs.readFileSync(path.join(dataDir, file));
        const pdfData = await pdfParse(dataBuffer);
        let text = pdfData.text.trim();

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
                    "Extract all staff names and roles from this FCA document. Format each item as 'Name – Title'. Keep it factual and concise. Place each name/title pair on a new line. Do not include any introductory or concluding text."
                },
                { role: "user", content: text.slice(0, 15000) }
              ]
            });

            const cleaned = summary.choices?.[0]?.message?.content?.trim();
            
            if (cleaned) {
                fcaKnowledge += `\n--- ${file} (summarized) ---\n${cleaned}\n`;
                // console.log(`**Extracted Staff and Roles from ${file}:**\n${cleaned}`); // Keep console clean
            } else {
              fcaKnowledge += `\n--- ${file} ---\n${text}\n`;
            }
          } catch (err) {
            console.warn(`⚠️ Could not summarize ${file}:`, err.message);
            fcaKnowledge += `\n--- ${file} ---\n${text}\n`;
          }
        } else {
          fcaKnowledge += `\n--- ${file} ---\n${text}\n`;
        }
      }
    }

    console.log("✅ Loaded and processed all FCA PDF files.");
  } catch (err) {
    console.error("⚠️ Error loading PDF files:", err);
  }
}

// 🗓️ Load Google Calendar URLs (unchanged)
async function loadAllCalendars() {
  // ... (unchanged calendar loading logic) ...
  try {
    if (!process.env.CALENDAR_URLS) return;

    const urls = process.env.CALENDAR_URLS.split(",").map(u => u.trim());
    const now = DateTime.now().setZone("America/New_York");
    let combined = "";

    for (const url of urls) {
      const res = await fetch(url);
      const data = await res.text();
      const events = ical.parseICS(data);

      for (const k in events) {
        const ev = events[k];
        if (ev.type !== "VEVENT") continue;

        const start = DateTime.fromJSDate(ev.start, { zone: "utc" })
          .setZone("America/New_York");
        const end = DateTime.fromJSDate(ev.end, { zone: "utc" })
          .setZone("America/New_York");

        if (end < now.minus({ days: 1 })) continue;

        const timeStr = `${start.toFormat("cccc, LLLL d")} from ${start.toFormat("h:mm a")} to ${end.toFormat("h:mm a")}`;
        const location = ev.location ? ` at ${ev.location}` : "";
        combined += `\n${ev.summary} — ${timeStr}${location}`;
      }
    }

    calendarText = combined || "No upcoming events found.";
    console.log("✅ Calendars loaded.");
  } catch (err) {
    console.warn("⚠️ Calendar load failed:", err.message);
  }
}

// 🚀 Initial load
await loadPDFs();
if (process.env.CALENDAR_URLS) {
  calendarURLs = process.env.CALENDAR_URLS.split(",").map((u) => u.trim());
  await loadAllCalendars();
}

// ✅ Root route
app.get("/", (req, res) => {
  res.status(200).send("✅ FCA Assistant backend is running.");
});


// 🛑 Define a list of full job titles to search for in a direct question (for heuristic use only)
const ROLE_KEYWORDS = [
    "superintendent", 
    "business manager", 
    "principal", 
    "director", 
    "counselor",
    "secondary principal",
    "elementary principal",
    "administrative assistant",
    "school nurse",
    "dean of students"
];

/**
 * Uses the LLM to reliably extract a clean first and last name from the knowledge base,
 * based on a user query that may contain a name or a role. Includes a retry loop.
 */
async function extractNameFromQuery(query, knowledge) {
    const prompt = `Analyze the following user query and staff data. Your goal is to extract the first name and last name of the relevant person.

    **USER QUERY (Name or Role to find):** "${query}"

    **STAFF DATA:**
    ---
    ${knowledge}
    ---
    
    **CRITICAL INSTRUCTION & LOGIC:**
    1. **If the query is a NAME (e.g., 'Jeffrey Baker', 'Mrs. Walls'):** Search for that name exactly. If multiple matches exist (e.g., two people named 'Michael'), select the person with the most senior or relevant title.
    2. **If the query is a ROLE (e.g., 'Principal', 'Business Manager'):**
       - First, search for the role exactly.
       - If the exact role is not found (e.g., 'Principal' is asked, but only 'Secondary Principal' exists), you **MUST** select the most appropriate person based on the closest administrative title (e.g., choosing 'Secondary Principal' or the highest-ranking principal).
    3. Extract the full first and last name.
    4. Ensure **ALL courtesy titles (Mr., Mrs., Dr., etc.) are stripped** from the names.
    5. The names must be returned in **lowercase** and placed in a single string, separated by a comma (e.g., "first,last").
    6. Respond **ONLY** with the comma-separated string. If NO plausible name can be found, respond **ONLY** with an empty string.
    `;

    // 🎯 Use a retry loop for robust extraction
    for (let i = 0; i < 3; i++) { 
        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                temperature: i === 0 ? 0.0 : 0.1 
            });

            const resultString = completion.choices[0]?.message?.content?.trim() || '';

            // Parsing the simple comma-separated string
            if (resultString) {
                const parts = resultString.split(',');
                if (parts.length === 2) {
                    const first = parts[0].trim().toLowerCase();
                    const last = parts[1].trim().toLowerCase();
                    
                    // Basic validation to ensure a name was actually extracted
                    if (first.length > 1 && last.length > 1 && !first.includes('name') && !last.includes('title')) {
                        console.log(`✅ Name found on attempt ${i + 1}: ${first}, ${last}`);
                        return [first, last]; // Success!
                    }
                }
            }
            console.warn(`⚠️ Attempt ${i + 1} failed to extract valid name. Retrying...`);
        } catch (err) {
            console.error(`⚠️ LLM Name Extraction attempt ${i + 1} failed:`, err.message);
        }
    }
    
    return null; // Return null only after all retries fail
}


app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];
    let lastUserMessage = userMessages[userMessages.length - 1]?.content || ""; 

    // 📧 Email shortcut logic
    if (/(email|contact)/i.test(lastUserMessage)) {
      
      // 1. Strip possessive forms and courtesy titles for a cleaner search query
      const cleanedMessage = lastUserMessage
        .replace(/'s|s'/gi, '')
        .replace(/(mrs|mr|dr|ms)\.?\s*/gi, '');
      
      // 2. Use the robust LLM function for contextual name/role extraction
      const nameExtractionResult = await extractNameFromQuery(cleanedMessage, fcaKnowledge);
      
      let first = nameExtractionResult ? nameExtractionResult[0] : null;
      let last = nameExtractionResult ? nameExtractionResult[1] : null;

      // Check if the LLM successfully extracted the name
      if (first && last) {
        
        // 3. Email found! Build the final response.
        const displayName = `${capitalize(first)} ${capitalize(last)}`;
        const email = `${first}.${last}@${EMAIL_DOMAIN}`;
        
        let whoIsAnswer = "";
        
        // Heuristic to try and determine the role for a better response
        const lowerMessage = cleanedMessage.toLowerCase();
        let foundRole = ROLE_KEYWORDS.find(role => lowerMessage.includes(role));

        if (foundRole) {
            whoIsAnswer = `The email for the **${capitalize(foundRole)}** (${displayName}) is: **${email}**.`;
        } else {
            // Simple response for direct name queries
            whoIsAnswer = `The email address for **${displayName}** is: **${email}**.`;
        }

        return res.json({
          reply: {
            role: "assistant",
            content: whoIsAnswer,
          },
        });
      }

      // 4. Final fallback (no name found after 3 LLM attempts)
      return res.json({
        reply: {
          role: "assistant",
          content:
            `I couldn't find a name for that person or role in the documents after multiple attempts. If you can confirm the full first and last name, I can provide the email address (format: FirstName.LastName@${EMAIL_DOMAIN}).`,
        },
      });
    }

    // 🧠 Otherwise, continue to OpenAI for normal FCA Q&A (unchanged)
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
