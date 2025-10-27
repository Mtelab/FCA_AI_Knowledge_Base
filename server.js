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

// 📘 Load PDFs from /data (Updated to handle non-capitalized names and log)
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
                  // Instructing AI to extract names and roles, keeping the formatting simple
                  content:
                    "Extract all staff names and roles from this FCA document. Format each item as 'Name – Title'. Keep it factual and concise. Place each name/title pair on a new line. Do not include any introductory or concluding text."
                },
                { role: "user", content: text.slice(0, 15000) }
              ]
            });

            const cleaned = summary.choices?.[0]?.message?.content?.trim();
            if (cleaned) {
              fcaKnowledge += `\n--- ${file} (summarized) ---\n${cleaned}\n`;
              // 🛑 LOGGING NAMES AND ROLES
              console.log(`**Extracted Staff and Roles from ${file}:**\n${cleaned}`);
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


// 🛑 Define the master list of junk words for filtering (all lowercase)
const MASTER_JUNK_WORDS = new Set([
  // General filler/question words
  "what", "is", "address", "the", "for", "please", "give", "me", "of", "do", "you", "know",
  "tell", "can", "someone", "send", "need", "get", "find", "contact", "info", "a", "his", "her", "and", "an", "i", "apologize", "who", "be",
  "that", "system", "answers", "to", "get", // 🛑 Added "that", "answers", "system", "to", "get"
  // Titles/Salutations/Roles (these are also on the ROLE_KEYWORDS list below, but keeping them here for name filtering)
  "mr", "mrs", "ms", "miss", "dr", "teacher", "pastor", "principal", "coach", 
  "director", "head", "administrator", "business", "manager", "counselor", "assistant",
  // Organizational Names (to avoid matching "Faith Christian" as a name)
  "faith", "christian", "academy", "school", "at", "fca", 
  // Common short prepositions/articles often part of titles
  "in", "on", "by", "from", "with"
]);

// 🛑 Define a list of full job titles to search for in a direct question (order by length/specificity)
const ROLE_KEYWORDS = [
    "head of school", 
    "business administrator", 
    "business manager", 
    "administrator", 
    "principal", 
    "pastor", 
    "teacher", 
    "coach", 
    "director", 
    "counselor"
];

/**
 * Searches the message history for the most recently mentioned full name.
 * @param {Array} messages - The conversation message history.
 * @returns {Array|null} - An array [FirstName, LastName] (capitalized) or null.
 */
function findContextualName(messages) {
    const namePattern = /\b([a-zA-Z]+)\s+([a-zA-Z]+)\b/g; 
    
    for (let i = messages.length - 2; i >= 0; i--) {
        const content = messages[i]?.content || "";
        
        let match;
        namePattern.lastIndex = 0; 
        
        while ((match = namePattern.exec(content)) !== null) {
            const firstName = match[1];
            const lastName = match[2];
            
            const lowerFirstName = firstName.toLowerCase();
            const lowerLastName = lastName.toLowerCase();
            
            if (!MASTER_JUNK_WORDS.has(lowerFirstName) && !MASTER_JUNK_WORDS.has(lowerLastName)) {
                return [capitalize(firstName), capitalize(lastName)];
            }
        }
    }
    return null; 
}

/**
 * Attempts to find a Name based on a Role Title found in the message, by searching the specific line.
 * @param {string} role - The job role to search for (e.g., "business administrator").
 * @returns {Array|null} - An array [FirstName, LastName] (lowercase) or null.
 */
function findNameByRole(role) {
    const escapedRole = role.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    
    // Split the knowledge into individual lines
    const knowledgeLines = fcaKnowledge.split('\n');
    
    let bestName = null;
    
    // Find the relevant line(s) containing the role
    for (const line of knowledgeLines) {
        const lowerLine = line.toLowerCase();
        
        if (lowerLine.includes(role)) {
            // Found a line containing the role. Now, search only this line for the name.
            
            // Regex finds any two words separated by a space, regardless of case, 
            // but we constrain it to the front of the line (before the role)
            const namePattern = /\b([a-zA-Z]+)\s+([a-zA-Z]+)\b/g; 
            let match;
            
            // We search the entire line, and use the word filter to validate the name
            while ((match = namePattern.exec(line)) !== null) {
                const firstName = match[1];
                const lastName = match[2];
                
                const lowerFirstName = firstName.toLowerCase();
                const lowerLastName = lastName.toLowerCase();
                
                // Use the comprehensive junk word filter
                if (!MASTER_JUNK_WORDS.has(lowerFirstName) && !MASTER_JUNK_WORDS.has(lowerLastName)) {
                    // This is the last valid name found on this line, which is the best candidate
                    bestName = [lowerFirstName, lowerLastName];
                }
            }
            
            // If we found a name on this line, return it immediately
            if (bestName) {
                return bestName; 
            }
        }
    }

    return null;
}

app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";
    
    const junkWords = MASTER_JUNK_WORDS;

    // 📧 Email shortcut logic
    if (/(email|contact)/i.test(lastUserMessage)) {
      
      let first = "", last = "";
      let foundRole = null; 

      // 🛑 Step 1: High Priority - Search by Role (for single-pass questions)
      if (/(who is|who's|his|her)/i.test(lastUserMessage)) {
          const lowerMessage = lastUserMessage.toLowerCase();
          
          for (const role of ROLE_KEYWORDS) {
              if (lowerMessage.includes(role)) {
                  foundRole = role;
                  break; 
              }
          }
          
          if (foundRole) {
              const nameByRole = findNameByRole(foundRole);
              if (nameByRole) {
                  [first, last] = nameByRole; 
              }
          }
      }
      
      // 🛑 Step 2: Fallback - Check conversation history for a context name
      if (!first && /(his|her)/i.test(lastUserMessage)) {
          const contextName = findContextualName(userMessages);
          if (contextName) {
              [first, last] = [contextName[0].toLowerCase(), contextName[1].toLowerCase()]; 
          }
      }

      // Step 3: Fallback - Try to parse a name directly from the current message
      if (!first) {
          const rawWords = lastUserMessage.split(/[^a-zA-Z]+/).filter(w => w);
          const words = rawWords
              .map(w => w.toLowerCase())
              .filter(w => !junkWords.has(w));
          
          if (words.length >= 2) {
            [first, last] = words.slice(0, 2);

          } else if (words.length === 1) {
            const singleWord = words[0];
            const knowledgeSearchPattern = new RegExp(`\\b${singleWord}\\b`, 'i');

            if (knowledgeSearchPattern.test(fcaKnowledge)) {
              const presumedLastName = singleWord; 
              
              const fullMatchRegex = new RegExp(`\\b([a-zA-Z]+)\\s+${presumedLastName}\\b`, 'g');
              const allMatches = Array.from(fcaKnowledge.matchAll(fullMatchRegex));
              
              let foundFirstName = null;

              for (const match of allMatches) {
                  const potentialFirstName = match[1];
                  
                  if (!junkWords.has(potentialFirstName.toLowerCase())) {
                      foundFirstName = potentialFirstName;
                      break; 
                  }
              }
              
              if (foundFirstName) {
                first = foundFirstName.toLowerCase();
                last = presumedLastName;
              } else {
                const emailFormat = `FirstName.${presumedLastName}@faithchristianacademy.net`;
                return res.json({
                  reply: {
                    role: "assistant",
                    content: `I found a reference to **${capitalize(presumedLastName)}** in the FCA documents but couldn't confirm the first name. The email format for them is **${emailFormat}**. You will need to replace 'FirstName' with their actual first name.`,
                  },
                });
              }
            }
          }
      }

      // Step 4: Final output with name and email
      if (first && last) {
        const displayName = `${capitalize(first)} ${capitalize(last)}`;
        const email = `${first}.${last}@faithchristianacademy.net`;
        
        let whoIsAnswer = "";
        if ((lastUserMessage.toLowerCase().includes("who is") || lastUserMessage.toLowerCase().includes("who's")) && foundRole) {
            whoIsAnswer = `The ${capitalize(foundRole)} is **${displayName}**.\n\n`; 
        }

        return res.json({
          reply: {
            role: "assistant",
            content: `${whoIsAnswer}The email address for ${displayName} is likely **${email}**.`,
          },
        });
      }

      // Step 5: Final fallback (no name found)
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
