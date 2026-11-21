// The welcome email, sent once when someone first confirms their Comquat
// account (Nov 2026). Wording signed off by Neil on 21 November 2026.
// It explains the three AI settings, the human gate and why they matter.
// Replies go to customer.service@, so ideas reach a real inbox.

const { esc, shell, P, BTN, sendViaResend } = require("./emails");

const REPLY_TO = process.env.WELCOME_REPLY_TO || "customer.service@the-common-people.com";
const LINKS = {
  account: "https://cv.the-common-people.com/account/me.html#ai",
  promise: "https://the-common-people.com/ai-promise.html",
  privacy: "https://cv.the-common-people.com/privacy.html",
  safeguarding: "https://cv.the-common-people.com/safeguarding.html",
};

const H = (t) => `<h2 style="font-size:18px;line-height:1.3;margin:24px 0 8px">${t}</h2>`;
const UL = (items) => `<ul style="font-size:16px;line-height:1.55;margin:0 0 16px;padding-left:20px">${items.map((i) => `<li style="margin:0 0 6px">${i}</li>`).join("")}</ul>`;
const A = (href, label) => `<a href="${href}" style="color:#1F6B45">${esc(label)}</a>`;

function firstName(full) {
  const f = String(full || "").trim().split(/\s+/)[0] || "";
  return f.length > 1 && f.length < 40 ? f : "";
}

function build(name) {
  const hi = firstName(name) ? `Hi ${esc(firstName(name))},` : "Hi there,";
  const subject = "Welcome to Comquat. You're in charge of the AI.";

  const html = shell("WELCOME", [
    P(hi),
    P("Welcome to Comquat. Your free account gives you three tools to help you land your next job."),
    P("<strong>CV Rewrite</strong> tailors your CV to the job you want, in your own words."),
    P("<strong>Interview Prep</strong> builds you a personal prep report from your CV and the job description. Answer a few questions, typed or just spoken out loud, and you'll get:"),
    UL([
      "<strong>Real research on the company:</strong> what they do, their recent news, what staff say about working there and the pressures on their industry. Every source is linked so you can check it yourself.",
      "<strong>The honest challenges</strong> you may face in the role",
      "<strong>Your \"tell me about yourself\" answer</strong>, built from your real CV",
      "<strong>A gap check:</strong> where you're strong, where there's a gap and how to handle it",
      "<strong>Your own examples</strong> turned into clear STAR answers (Situation, Task, Action, Result)",
      "<strong>Sharp questions to ask them</strong>, based on the actual job",
    ]),
    P("It all comes as a Word document you can take into the interview."),
    P("<strong>CV Builder</strong> talks it through with you and builds your CV, whether it's your first one, an update, or you're heading back to work."),

    H("How we use AI"),
    P("Comquat uses AI, but only as much as you want. You start on <strong>Essentials only</strong>, which means AI does the main job of each tool and nothing more."),
    P("You can change this any time in My account:"),
    UL([
      "<strong>Full help</strong> adds extras, like suggested job roles and help with your intro video script",
      "<strong>Essentials only</strong> means AI does the core job, nothing extra",
      "<strong>Off</strong> means no AI at all. We'll point you to our free guides, templates and checklists instead",
    ]),
    `<p style="margin:0 0 16px">${BTN(LINKS.account, "Choose your AI setting")}</p>`,

    H("Nothing goes anywhere without you"),
    P("AI can make mistakes. So everything it writes is labelled, and nothing leaves Comquat until you've checked it. Before you download a CV, you tick a box to confirm it's true and nothing has been made up. A human is always in charge, and that human is you."),

    H("What AI never does"),
    UL([
      "It never sees your name, contact details or photos. We strip them out first.",
      "It never makes decisions about you.",
      "We test the CV Builder's AI for bias every month and after every change.",
    ]),

    H("Why this matters to us"),
    P("I spent nine years in recruitment, and the best bit was always the people. Getting to know them, and sticking with them when the job search got hard. And finding them the job that was right for them. Not just any job. The right one."),
    P("I'm also a dad. One of my children has a disability and another has autism. So I know how much it matters that people are seen for who they are, not pushed through a process that was never built with them in mind."),
    P("That's why Comquat is built on values. Skills get you through the door, but the right fit comes from what you care about and how you like to work. AI can help with the typing. It can't know you. That part is yours, and our job is to make sure you're always the one in charge."),

    H("Got an idea?"),
    P("If there's something you'd like Comquat to do, we'd love to hear it. Just reply to this email and tell us. Comquat is built for you, so your ideas help shape what comes next."),

    P("Neil<br>Founder, Comquat"),
    `<p style="font-size:14px;line-height:1.5;margin:0">${A(LINKS.promise, "Our AI promise")} &middot; ${A(LINKS.privacy, "Privacy notice")} &middot; ${A(LINKS.safeguarding, "Safeguarding")}</p>`,
  ].join("\n"));

  const text = [
    firstName(name) ? `Hi ${firstName(name)},` : "Hi there,",
    "",
    "Welcome to Comquat. Your free account gives you three tools to help you land your next job.",
    "",
    "CV Rewrite tailors your CV to the job you want, in your own words.",
    "",
    "Interview Prep builds you a personal prep report from your CV and the job description. Answer a few questions, typed or just spoken out loud, and you'll get:",
    "- Real research on the company: what they do, their recent news, what staff say about working there and the pressures on their industry. Every source is linked so you can check it yourself.",
    "- The honest challenges you may face in the role",
    "- Your \"tell me about yourself\" answer, built from your real CV",
    "- A gap check: where you're strong, where there's a gap and how to handle it",
    "- Your own examples turned into clear STAR answers (Situation, Task, Action, Result)",
    "- Sharp questions to ask them, based on the actual job",
    "It all comes as a Word document you can take into the interview.",
    "",
    "CV Builder talks it through with you and builds your CV, whether it's your first one, an update, or you're heading back to work.",
    "",
    "HOW WE USE AI",
    "Comquat uses AI, but only as much as you want. You start on Essentials only, which means AI does the main job of each tool and nothing more.",
    "You can change this any time in My account:",
    "- Full help adds extras, like suggested job roles and help with your intro video script",
    "- Essentials only means AI does the core job, nothing extra",
    "- Off means no AI at all. We'll point you to our free guides, templates and checklists instead",
    `Choose your AI setting: ${LINKS.account}`,
    "",
    "NOTHING GOES ANYWHERE WITHOUT YOU",
    "AI can make mistakes. So everything it writes is labelled, and nothing leaves Comquat until you've checked it. Before you download a CV, you tick a box to confirm it's true and nothing has been made up. A human is always in charge, and that human is you.",
    "",
    "WHAT AI NEVER DOES",
    "- It never sees your name, contact details or photos. We strip them out first.",
    "- It never makes decisions about you.",
    "- We test the CV Builder's AI for bias every month and after every change.",
    "",
    "WHY THIS MATTERS TO US",
    "I spent nine years in recruitment, and the best bit was always the people. Getting to know them, and sticking with them when the job search got hard. And finding them the job that was right for them. Not just any job. The right one.",
    "I'm also a dad. One of my children has a disability and another has autism. So I know how much it matters that people are seen for who they are, not pushed through a process that was never built with them in mind.",
    "That's why Comquat is built on values. Skills get you through the door, but the right fit comes from what you care about and how you like to work. AI can help with the typing. It can't know you. That part is yours, and our job is to make sure you're always the one in charge.",
    "",
    "GOT AN IDEA?",
    "If there's something you'd like Comquat to do, we'd love to hear it. Just reply to this email and tell us. Comquat is built for you, so your ideas help shape what comes next.",
    "",
    "Neil",
    "Founder, Comquat",
    "",
    `Our AI promise: ${LINKS.promise}`,
    `Privacy notice: ${LINKS.privacy}`,
    `Safeguarding: ${LINKS.safeguarding}`,
  ].join("\n");

  return { subject, html, text };
}

async function send(to, name) {
  if (!to) return;
  await sendViaResend(to, build(name), { "Reply-To": REPLY_TO });
}

module.exports = { send, build, REPLY_TO, LINKS };
