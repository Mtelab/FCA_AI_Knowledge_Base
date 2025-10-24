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

function addMessage(content, sender, id = null) {
  const msg = document.createElement("div");

  // Allow multiple CSS classes like "bot thinking"
  if (sender.includes(" ")) msg.classList.add(...sender.split(" "));
  else msg.classList.add(sender);

  // Clean and normalize escaped newlines
  let formatted = content.replace(/\\n/g, "\n").replace(/\r\n/g, "\n");

  // 🧠 Auto-insert line breaks before bold section headers (like **Elementary**)
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, "\n<strong>$1</strong>\n");

  // 🧹 Split long sentences at periods if it's one big wall
  if (!formatted.includes("\n")) {
    formatted = formatted.replace(/\. ([A-Z])/g, ".<br><br>$1");
  }

  // 🪄 Convert dashes to bullets, newlines to <br>
  formatted = formatted
    .replace(/- /g, "<br>• ")
    .replace(/\n+/g, "<br>");

  msg.innerHTML = formatted.trim();
  if (id) msg.id = id;

  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
  return msg;
}

// ✨ Create an animated "thinking..." indicator
function addThinkingMessage() {
  const id = "thinking-" + Date.now();
  const msg = addMessage("Assistant is thinking", "bot thinking", id);

  let dotCount = 0;
  const interval = setInterval(() => {
    const el = document.getElementById(id);
    if (!el) {
      clearInterval(interval);
      return;
    }
    dotCount = (dotCount + 1) % 4; // cycles through 0–3 dots
    el.textContent = "Assistant is thinking" + ".".repeat(dotCount);
  }, 500);

  return { id, interval };
}

// 🚀 Check backend status
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

// 💙💛 Falcon Light Show
function triggerFalconShow() {
  const show = document.getElementById("falcon-show");
  show.innerHTML = ""; // clear previous

  // Create laser beams
  for (let i = 0; i < 6; i++) {
    const laser = document.createElement("div");
    laser.className = "laser";
    laser.style.left = `${Math.random() * 100}%`;
    laser.style.animationDelay = `${Math.random()}s`;
    show.appendChild(laser);
  }

  // Create the falcon
  const falcon = document.createElement("div");
  falcon.className = "falcon";
  show.appendChild(falcon);

  // Remove after animation
  setTimeout(() => {
    show.innerHTML = "";
  }, 6000);
}

// 💬 Send message
async function sendMessage() {
  const text = userInput.value.trim();
  if (!text) return;

  addMessage(text, "user");
  conversation.push({ role: "user", content: text });
  userInput.value = "";

  // ⏳ Add "thinking" message and animation
  const thinking = addThinkingMessage();

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: conversation })
    });

    if (!res.ok) throw new Error("Network response was not ok");
    const data = await res.json();
    const reply = data.reply?.content || "Sorry, I couldn’t get a response.";

    // Replace "thinking" message with actual response
    const el = document.getElementById(thinking.id);
    if (el) {
      el.textContent = reply;
      el.classList.remove("thinking");
    }
    clearInterval(thinking.interval);

    conversation.push({ role: "assistant", content: reply });
  } catch (err) {
    console.error("Error sending message:", err);
    const el = document.getElementById(thinking.id);
    if (el) {
      el.textContent =
        "⚠️ The FCA Assistant is still starting up. Please try again shortly.";
      el.classList.remove("thinking");
    }
    clearInterval(thinking.interval);
  }
}

// 🎯 Event listeners
sendBtn.onclick = sendMessage;
userInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendMessage();
});

// 🔄 Check backend on load
window.addEventListener("load", checkBackendStatus);




