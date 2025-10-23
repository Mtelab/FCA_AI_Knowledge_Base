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

// 🧠 Add a message to the chat window
function addMessage(content, sender) {
  const msg = document.createElement("div");
  msg.classList.add("message", sender);
  msg.textContent = content;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// 🚀 Check if backend is awake, then hide the loading screen
async function checkBackendStatus() {
  const loadingEl = document.getElementById("loading");

  // After 15 seconds, if still loading, show an alternate message
  const timeout = setTimeout(() => {
    if (loadingEl.style.display !== "none") {
      loadingEl.textContent = "⏳ FCA Assistant is still waking up, please wait...";
    }
  }, 15000);

  try {
    const res = await fetch("/");
    if (res.ok) {
      clearTimeout(timeout);
      loadingEl.style.display = "none";
    } else {
      console.warn("Backend not ready yet...");
    }
  } catch (err) {
    console.warn("Backend unreachable:", err);
  }
}

// 📨 Send message to backend
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

    if (!res.ok) throw new Error("Network response was not ok");
    const data = await res.json();
    const reply = data.reply?.content || "Sorry, I couldn’t get a response.";
    addMessage(reply, "bot");
    conversation.push({ role: "assistant", content: reply });
  } catch (err) {
    console.error("Error sending message:", err);
    addMessage(
      "⚠️ The FCA Assistant is still starting up. Please wait a moment and try again.",
      "bot"
    );
  }
}

// 🎯 Event listeners
sendBtn.onclick = sendMessage;
userInput.addEventListener("keypress", e => {
  if (e.key === "Enter") sendMessage();
});

// 🔄 Run check on page load
window.addEventListener("load", checkBackendStatus);
