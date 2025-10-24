const chatBox = document.getElementById("chat-box");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");

let conversation = [
  {
    role: "system",
    content:
      "You are FCA Assistant, an AI that answers questions about Faith Christian Academy."
  }
];

// 🧠 Add message to chat window
function addMessage(content, sender, id = null) {
  const msg = document.createElement("div");
  msg.classList.add("message", sender);
  msg.textContent = content;
  if (id) msg.id = id;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
  return msg;
}

// 🚀 Check backend
async function checkBackendStatus() {
  const loadingEl = document.getElementById("loading");
  const timeout = setTimeout(() => {
    if (loadingEl.style.display !== "none") {
      loadingEl.textContent =
        "⏳ FCA Assistant is still waking up, please wait...";
    }
  }, 15000);

  try {
    const res = await fetch("/");
    if (res.ok) {
      clearTimeout(timeout);
      loadingEl.style.display = "none";
    }
  } catch (err) {
    console.warn("Backend unreachable:", err);
  }
}

// 💬 Send message
async function sendMessage() {
  const text = userInput.value.trim();
  if (!text) return;

  addMessage(text, "user");
  conversation.push({ role: "user", content: text });
  userInput.value = "";

  // ⏳ Temporary "thinking" message
  const thinkingId = "thinking-" + Date.now();
  addMessage("Assistant is thinking...", "bot thinking", thinkingId);

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: conversation })
    });

    if (!res.ok) throw new Error("Network response was not ok");
    const data = await res.json();

    const reply = data.reply?.content || "Sorry, I couldn’t get a response.";

    // Replace "thinking" with real answer
    const thinkingMsg = document.getElementById(thinkingId);
    if (thinkingMsg) thinkingMsg.textContent = reply;
    thinkingMsg?.classList.remove("thinking");
    conversation.push({ role: "assistant", content: reply });
  } catch (err) {
    console.error("Error sending message:", err);
    const thinkingMsg = document.getElementById(thinkingId);
    if (thinkingMsg)
      thinkingMsg.textContent =
        "⚠️ The FCA Assistant is still starting up. Please try again shortly.";
  }
}

// 🎯 Listeners
sendBtn.onclick = sendMessage;
userInput.addEventListener("keypress", e => {
  if (e.key === "Enter") sendMessage();
});

window.addEventListener("load", checkBackendStatus);
