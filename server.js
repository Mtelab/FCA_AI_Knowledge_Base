// ... (rest of the script remains the same)

app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";

    // 📧 Email shortcut logic
    if (/email/i.test(lastUserMessage)) {
      // Set of junk words in both lowercase and capitalized form for filtering
      const junkWords = new Set([
        // Lowercase versions (used for filtering user input)
        "what", "is", "email", "address", "the", "for", "please", "give", "me", "of", "do", "you", "know",
        "tell", "can", "someone", "send", "need", "get", "find", "contact", "info", "a", 
        "mr", "mrs", "ms", "miss", "dr", "teacher", "pastor", "principal", "coach", 
        // Capitalized versions (used for filtering extracted names from document content)
        "Mr", "Mrs", "Ms", "Miss", "Dr", "Teacher", "Pastor", "Principal", "Coach"
      ]);

      // Step 1: Clean the message to extract potential name words
      // We filter out known junk.
      const rawWords = lastUserMessage.split(/[^a-zA-Z]+/).filter(w => w);
      // Filter out words found in the junkWords set (checking both original and lowercase versions for safety)
      const words = rawWords.filter(w => !junkWords.has(w) && !junkWords.has(w.toLowerCase()));
      
      let first = "", last = "";
      
      // Step 2: Attempt to extract a first and last name from the message itself
      if (words.length >= 2) {
        // Found two likely names (e.g., "John Smith")
        [first, last] = words.slice(0, 2);

      } else if (words.length === 1) {
        // Found one word (e.g., "Hobbs")
        const singleWord = words[0];
        
        // Check if this single word exists in the documents
        const knowledgeSearchPattern = new RegExp(`\\b${singleWord}\\b`, 'i');

        if (knowledgeSearchPattern.test(fcaKnowledge)) {
          const presumedLastName = capitalize(singleWord);
          
          // 🚀 ADVANCED LOGIC: Try to find the first name in the FCA Knowledge
          // Search for a capitalized word immediately preceding the last name.
          const fullMatchRegex = new RegExp(`\\b([A-Z][a-z]+)\\s+${presumedLastName}\\b`, 'g');
          
          // Get all possible matches for a capitalized word followed by the last name
          const allMatches = Array.from(fcaKnowledge.matchAll(fullMatchRegex));
          
          let foundFirstName = null;

          for (const match of allMatches) {
              const potentialFirstName = match[1];
              
              // 🛑 CRITICAL FINAL CHECK: If the extracted word is a capitalized title, skip it.
              if (!junkWords.has(potentialFirstName)) {
                  foundFirstName = potentialFirstName;
                  break; // Found a valid first name, stop searching
              }
          }
          
          if (foundFirstName) {
            // Success! We found a real first name (e.g., "John")
            first = foundFirstName;
            last = presumedLastName;
            
            const email = `${first.toLowerCase()}.${last.toLowerCase()}@faithchristianacademy.net`;
            const displayName = `${capitalize(first)} ${capitalize(last)}`;
            
            return res.json({
                reply: {
                    role: "assistant",
                    content: `Based on the documents, the name is likely **${displayName}**. The email address is **${email}**.`,
                },
            });
          } else {
            // Fallback: Last name confirmed, but no valid, non-title first name found
            const emailFormat = `FirstName.${presumedLastName.toLowerCase()}@faithchristianacademy.net`;
            return res.json({
              reply: {
                role: "assistant",
                content: `I found a reference to **${presumedLastName}** in the FCA documents but couldn't confirm the first name. The email format for them is **${emailFormat}**. You will need to replace 'FirstName' with their actual first name.`,
              },
            });
          }
        }
        // If single word is NOT found in knowledge, it falls through to the generic fallback.
      }

      // Step 3: If a first and last name were successfully extracted from the message (Step 2)
      if (first && last) {
        const email = `${first.toLowerCase()}.${last.toLowerCase()}@faithchristianacademy.net`;
        const displayName = `${capitalize(first)} ${capitalize(last)}`;

        return res.json({
          reply: {
            role: "assistant",
            content: `The email address for ${displayName} is likely **${email}**.`,
          },
        });
      }

      // Step 4: Final fallback
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
