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
  // Capitalize the first letter of each word
  return str.split(' ').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join(' ');
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

        const isStaffDoc =
          file.toLowerCase().includes("support") ||
          file.toLowerCase().includes("staff") ||
          file.toLowerCase().includes("personnel") ||
          file.toLowerCase().includes("faculty") ||
          file.toLowerCase().includes("administration");

        if (isStaffDoc && text.length > 0) {
          console.log(`🧠 Summarizing ${file} for clearer staff listings...`);
          try {
            // Use LLM to structure staff data for better lookup
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

// 🗓️ Load Google Calendar URLs 
async function loadAllCalendars() {
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


/**
 * Uses the LLM to extract name and role in a reliable JSON format.
 */
async function extractNameFromQuery(query, knowledge) {
    const prompt = `
    **CRITICAL TASK: NAME AND ROLE EXTRACTION**
    
    Analyze the following **USER QUERY** and **STAFF DATA**. Your goal is to accurately identify the target person and their role, using contextual reasoning for the best possible match (e.g., if asked for "principal," select the highest-ranking principal available from the list, or the Secondary Principal if multiple are listed).
    
    **USER QUERY:** "${query}"
    
    **STAFF DATA (Names and Roles):**
    ---
    ${knowledge}
    ---
    
    **CRITICAL OUTPUT INSTRUCTION:**
    1. Extract the full first name, last name, and the specific role of the person.
    2. Strip ALL courtesy titles (Mr., Mrs., Dr., etc.).
    3. Return the result in **lowercase** and in the **EXACT JSON FORMAT** specified below.
    4. If NO plausible match is found, return the fallback JSON: {"first_name": "", "last_name": "", "role": ""}.
    
    **REQUIRED JSON FORMAT:**
    {"first_name": "...", "last_name": "...", "role": "..."}
    `;

    // Use a retry loop for robust JSON extraction
    for (let i = 0; i < 3; i++) { 
        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                temperature: i === 0 ? 0.0 : 0.1 
            });

            const resultString = completion.choices[0]?.message?.content?.trim() || '';
            
            // Clean the string (remove markdown fences, etc.) and parse as JSON
            const cleanString = resultString.replace(/```json|```/g, '').trim();
            const result = JSON.parse(cleanString);

            // Validation: Check for required keys and non-empty values
            if (result && result.first_name && result.last_name) {
                return result; // Success: returns {first_name, last_name, role}
            }
        } catch (err) {
            console.error(`⚠️ LLM Extraction attempt ${i + 1} failed:`, err.message);
        }
    }
    
    return {first_name: "", last_name: "", role: ""}; // Return empty object on total failure
}


app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];
    let lastUserMessage = userMessages[userMessages.length - 1]?.content || ""; 

    // 📧 Email shortcut logic - Trigger on 'email', 'contact', or a pronoun + 'email'/'contact'
    if (/(email|contact)/i.test(lastUserMessage) || /(her|his|their)\s*(email|contact|contact)/i.test(lastUserMessage)) {
      
      let extractionQuery = lastUserMessage;
      
      // *** CONTEXTUAL RESOLUTION FIX ***
      const isPronounQuery = /(her|his|their)/i.test(lastUserMessage);
      
      if (isPronounQuery && userMessages.length >= 2) {
          const previousAssistantReply = userMessages[userMessages.length - 2]?.content;

          // Use a simple LLM call to extract the name from the previous reply
          try {
              const nameFinder = await openai.chat.completions.create({
                  model: "gpt-4o-mini",
                  messages: [{
                      role: "user",
                      content: `Analyze the following text and extract only the full first and last name of the person mentioned. Return the name as a string (e.g., "Theresa Monro"), or an empty string if no clear name is found. Text: "${previousAssistantReply}"`
                  }],
                  temperature: 0.0
              });

              const resolvedName = nameFinder.choices[0]?.message?.content?.trim();
              
              if (resolvedName && resolvedName.length > 3) {
                  // Reconstruct the query: e.g., "what is her email" becomes "what is Theresa Monro's email"
                  extractionQuery = `what is ${resolvedName}'s email`;
                  console.log(`💡 Context resolved. New extraction query: ${extractionQuery}`);
              }
          } catch (e) {
              console.warn("⚠️ Failed to resolve pronoun context via LLM:", e.message);
              // Fallback to original message if LLM fails
          }
      }
      // *** END CONTEXTUAL RESOLUTION FIX ***
      
      // 1. Clean the message to remove noise like possessives and titles
      const cleanedMessage = extractionQuery
        .replace(/'s|s'/gi, '')
        .replace(/(mrs|mr|dr|ms)\.?\s*/gi, '');
      
      // 2. Use the robust JSON extraction function
      const nameExtractionResult = await extractNameFromQuery(cleanedMessage, fcaKnowledge);
      
      let first = nameExtractionResult.first_name;
      let last = nameExtractionResult.last_name;
      let role = nameExtractionResult.role; 

      // Check if the LLM successfully extracted the name
      if (first && last) {
        
        // 3. Email found! Build the final response.
        const displayName = `${capitalize(first)} ${capitalize(last)}`;
        const email = `${first}.${last}@${EMAIL_DOMAIN}`;
        
        let whoIsAnswer = "";

        // Use the role extracted by the LLM for a perfect response
        if (role) {
            // Capitalize the role for a professional response
            const displayRole = capitalize(role);
            whoIsAnswer = `The email for the **${displayRole}** (${displayName}) is: **${email}**.`;
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
