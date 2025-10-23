const chatBox = document.getElementById("chat-box");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");

let conversation = [
  { role: "system", content: "You are FCA Assistant, an AI that answers questions about Faith Christian Academy." }
];

function addMessage(content, sender) {
  const msg = document.createElement("div");
  msg.classList.add("message", sender);
  msg.textContent = content;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function sendMessage() {
  const text = userInput.value.trim();
  if (!text) return;

  addMessage(text, "user");
  conversation.push({ role: "user", content: text });
  userInput.value = "";

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: conversation })
    });
    const data = await res.json();
    const reply = data.reply?.content || "Sorry, I couldn’t get a response.";
    addMessage(reply, "bot");
    conversation.push({ role: "assistant", content: reply });
  } catch (err) {
    addMessage("⚠️ Network error. Please try again.", "bot");
  }
}

sendBtn.onclick = sendMessage;
userInput.addEventListener("keypress", e => {
  if (e.key === "Enter") sendMessage();
});
