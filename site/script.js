const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
document.documentElement.classList.add("motion-ready");

function showCopied(button) {
  window.clearTimeout(Number(button.dataset.resetTimer));
  button.classList.add("is-copied");
  button.dataset.resetTimer = String(
    window.setTimeout(() => {
      button.classList.remove("is-copied");
      delete button.dataset.resetTimer;
    }, 2000),
  );
}

function fallbackCopy(value) {
  const temporary = document.createElement("textarea");
  temporary.value = value;
  temporary.setAttribute("readonly", "");
  temporary.style.cssText = "position:fixed;inset:0 auto auto -9999px;opacity:0";
  document.body.append(temporary);
  temporary.select();
  const copied = document.execCommand("copy");
  temporary.remove();
  return copied;
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const value = button.dataset.copy ?? "";
    let copied = false;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        copied = true;
      } else {
        copied = fallbackCopy(value);
      }
    } catch {
      copied = fallbackCopy(value);
    }

    if (copied) showCopied(button);
  });
}

function countUp(container) {
  const duration = 1100;

  for (const number of container.querySelectorAll("[data-count]")) {
    const target = Number(number.dataset.count);
    const start = performance.now();

    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      number.textContent = Math.round(target * eased).toLocaleString("en-US");
      if (progress < 1) window.requestAnimationFrame(tick);
    }

    window.requestAnimationFrame(tick);
  }
}

if (!reducedMotion && "IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in-view");
        if (entry.target.classList.contains("evidence-ledger")) countUp(entry.target);
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.16, rootMargin: "0px 0px -8%" },
  );

  for (const element of document.querySelectorAll(".observe")) revealObserver.observe(element);
} else {
  for (const element of document.querySelectorAll(".observe")) element.classList.add("in-view");
}

const commandText = document.querySelector("#install .command-text");
if (commandText && !reducedMotion) {
  const command = commandText.textContent.trimStart();
  commandText.textContent = " ";
  let character = 0;

  window.setTimeout(() => {
    const typeNext = () => {
      character += 1;
      commandText.textContent = ` ${command.slice(0, character)}`;
      if (character < command.length) window.setTimeout(typeNext, 38);
    };
    typeNext();
  }, 650);
}

const navLinks = [...document.querySelectorAll(".anchor-nav a")];
const navSections = navLinks
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);

if ("IntersectionObserver" in window && navSections.length > 0) {
  const visibleSections = new Map();
  const navObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) visibleSections.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
      const active = [...visibleSections.entries()].sort((a, b) => b[1] - a[1])[0];
      if (!active || active[1] === 0) return;

      for (const link of navLinks) {
        const isActive = link.getAttribute("href") === `#${active[0]}`;
        if (isActive) link.setAttribute("aria-current", "true");
        else link.removeAttribute("aria-current");
      }
    },
    { threshold: [0.15, 0.35, 0.6], rootMargin: `-${88}px 0px -45%` },
  );

  for (const section of navSections) navObserver.observe(section);
}
