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
                  // NOTE: Changed system prompt to allow AI to decide capitalization for flexibility
                  content:
                    "Extract all staff names and roles from this FCA document. Format each item as 'Name – Title'. Keep it factual and concise. Place each name/title pair on a new line."
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
  // Titles/Salutations/Roles (these are also on the ROLE_KEYWORDS list below, but keeping them here for name filtering)
  "mr", "mrs", "ms", "miss", "dr", "teacher", "pastor", "principal", "coach", 
  "director", "head", "administrator", "business", "manager", "counselor", "assistant",
  // Organizational Names (to avoid matching "Faith Christian" as a name)
  "faith", "christian", "academy", "school", "to", "at", "fca", 
  // Common short prepositions/articles often part of titles
  "in", "on", "by", "from"
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
 * NOTE: This function still relies on capitalization for efficiency, assuming the AI's *previous* response was capitalized.
 * @param {Array} messages - The conversation message history.
 * @returns {Array|null} - An array [FirstName, LastName] (capitalized) or null.
 */
function findContextualName(messages) {
    // Regex finds any two words separated by a space, regardless of case
    const namePattern = /\b([a-zA-Z]+)\s+([a-zA-Z]+)\b/g; 
    
    // Iterate backward from the second-to-last message (0-index)
    for (let i = messages.length - 2; i >= 0; i--) {
        const content = messages[i]?.content || "";
        
        let match;
        // Reset the regex state for each new string
        namePattern.lastIndex = 0; 
        
        while ((match = namePattern.exec(content)) !== null) {
            const firstName = match[1];
            const lastName = match[2];
            
            // Normalize to lowercase for comparison against MASTER_JUNK_WORDS
            const lowerFirstName = firstName.toLowerCase();
            const lowerLastName = lastName.toLowerCase();
            
            // Validate that NEITHER the first nor the last word is in the junk set
            if (!MASTER_JUNK_WORDS.has(lowerFirstName) && !MASTER_JUNK_WORDS.has(lowerLastName)) {
                // Return the capitalized version of the name
                return [capitalize(firstName), capitalize(lastName)];
            }
        }
    }
    return null; // No valid name found in context
}

/**
 * Attempts to find a Name based on a Role Title found in the message, using a much more flexible search.
 * @param {string} role - The job role to search for (e.g., "business administrator").
 * @returns {Array|null} - An array [FirstName, LastName] (lowercase) or null.
 */
function findNameByRole(role) {
    const escapedRole = role.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    
    // Find the starting index of the role in the knowledge text
    const roleIndex = fcaKnowledge.toLowerCase().indexOf(role);

    if (roleIndex === -1) {
        return null;
    }

    // Grab a segment of text BEFORE the role (e.g., 200 characters)
    const searchStart = Math.max(0, roleIndex - 200);
    const searchArea = fcaKnowledge.substring(searchStart, roleIndex);
    
    // Regex finds any two words separated by a space, regardless of case, 
    // to accommodate non-capitalized names.
    const namePattern = /\b([a-zA-Z]+)\s+([a-zA-Z]+)\b/g; 
    let match;
    let bestName = null;
    
    // Iterate through all matches in the search area
    while ((match = namePattern.exec(searchArea)) !== null) {
        const firstName = match[1];
        const lastName = match[2];
        
        const lowerFirstName = firstName.toLowerCase();
        const lowerLastName = lastName.toLowerCase();
        
        // Use the comprehensive junk word filter
        if (!MASTER_JUNK_WORDS.has(lowerFirstName) && !MASTER_JUNK_WORDS.has(lowerLastName)) {
            // Keep track of the last *valid* name found, as it is most likely the correct name
            bestName = [lowerFirstName, lowerLastName];
        }
    }

    // Return the name closest to the role (which is the last one found in the preceding text)
    if (bestName) {
        return bestName; 
    }
    
    return null;
}

app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";
    
    // Use the consolidated MASTER_JUNK_WORDS set
    const junkWords = MASTER_JUNK_WORDS;

    // 📧 Email shortcut logic
    if (/(email|contact)/i.test(lastUserMessage)) {
      
      let first = "", last = "";
      let foundRole = null; // Track the role found

      // 🛑 Step 1: High Priority - Search by Role (for single-pass questions)
      if (/(who is|who's|his|her)/i.test(lastUserMessage)) {
          const lowerMessage = lastUserMessage.toLowerCase();
          
          // Find the most specific (longest) matching role keyword first
          for (const role of ROLE_KEYWORDS) {
              if (lowerMessage.includes(role)) {
                  foundRole = role;
                  break; 
              }
          }
          
          if (foundRole) {
              const nameByRole = findNameByRole(foundRole);
              if (nameByRole) {
                  // Names from findNameByRole are already lowercase
                  [first, last] = nameByRole; 
              }
          }
      }
      
      // 🛑 Step 2: Fallback - Check conversation history for a context name
      if (!first && /(his|her)/i.test(lastUserMessage)) {
          const contextName = findContextualName(userMessages);
          if (contextName) {
              // Context names are returned capitalized, so we lowercase them for email construction
              [first, last] = [contextName[0].toLowerCase(), contextName[1].toLowerCase()]; 
          }
      }

      // Step 3: Fallback - Try to parse a name directly from the current message
      // (This logic is less likely to succeed with complex "who is" queries but remains as a safety net)
      if (!first) {
          // Extract words and convert to lowercase for filtering
          const rawWords = lastUserMessage.split(/[^a-zA-Z]+/).filter(w => w);
          const words = rawWords
              .map(w => w.toLowerCase())
              .filter(w => !junkWords.has(w));
          
          if (words.length >= 2) {
            // Found two likely names (e.g., "john smith")
            [first, last] = words.slice(0, 2);

          } else if (words.length === 1) {
            // Found one word (e.g., "hobbs")
            const singleWord = words[0];
            
            // Check if this single word exists in the documents
            const knowledgeSearchPattern = new RegExp(`\\b${singleWord}\\b`, 'i');

            if (knowledgeSearchPattern.test(fcaKnowledge)) {
              const presumedLastName = singleWord; 
              
              // 🚀 ADVANCED LOGIC: Try to find the first name in the FCA Knowledge
              // Using a simple word-match for non-capitalized names
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
                // Fallback: Last name confirmed, but no valid first name found
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
        // Names are already lowercased (first, last)
        const displayName = `${capitalize(first)} ${capitalize(last)}`;
        const email = `${first}.${last}@faithchristianacademy.net`;
        
        let whoIsAnswer = "";
        // Only preface with "The person is..." if the user asked "who is"
        if ((lastUserMessage.toLowerCase().includes("who is") || lastUserMessage.toLowerCase().includes("who's")) && foundRole) {
            // We successfully found the name by role, so we answer the "who is" part
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
