/* sandfit site: one orchestrated hero moment, a few scroll cues, and the small interactions. */
(() => {
  "use strict";

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Copy buttons ---------- */
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy");
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = Object.assign(document.createElement("textarea"), { value: text });
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.append(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      btn.textContent = "Copied";
      btn.setAttribute("data-copied", "");
      btn.setAttribute("aria-live", "polite");
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        btn.textContent = "Copy";
        btn.removeAttribute("data-copied");
      }, 1800);
    });
  });

  /* ---------- Sandbox tabs (roving tabindex, arrow keys) ---------- */
  document.querySelectorAll("[data-install]").forEach((box) => {
    const tabs = [...box.querySelectorAll('[role="tab"]')];
    if (!tabs.length) return;
    const what = box.querySelector("[data-what]");
    const cmd = box.querySelector("[data-cmd-text]");
    const copy = box.querySelector("#cmd-panel [data-copy]");
    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
      });
      what.textContent = tab.dataset.what;
      cmd.textContent = tab.dataset.cmd;
      copy.setAttribute("data-copy", tab.dataset.cmd);
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => select(tab, false));
      tab.addEventListener("keydown", (e) => {
        const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        select(tabs[(next + tabs.length) % tabs.length], true);
      });
    });
  });

  /* ---------- How it works: the terminal follows the active step ---------- */
  const steps = [...document.querySelectorAll(".step")];
  const screens = [...document.querySelectorAll(".term__screen")];
  const activate = (i) => {
    steps.forEach((s, j) => s.classList.toggle("is-active", j === i));
    screens.forEach((s, j) => s.classList.toggle("is-active", j === i));
  };

  const hero = document.querySelector(".hero");
  const core = document.querySelector(".hero__core");
  const lineSvg = document.querySelector(".fitted__line");
  const lineRects = lineSvg.querySelectorAll("rect");
  const lineRect = lineSvg.querySelector(".reveal");

  /** Put the dashed line around the headline block. */
  const placeLine = () => {
    const h = hero.getBoundingClientRect();
    const c = core.getBoundingClientRect();
    // As much breathing room as fits beside the block, up to 36px, never past the screen edge.
    const pad = Math.max(8, Math.min(36, (h.width - c.width) / 2 - 6));
    lineRects.forEach((r) => {
      r.setAttribute("x", String(c.left - h.left - pad));
      r.setAttribute("y", String(c.top - h.top - pad));
      r.setAttribute("width", String(c.width + pad * 2));
      r.setAttribute("height", String(c.height + pad * 2));
    });
  };
  placeLine();

  // The boundary around what's allowed: sized to its box (in both paths).
  const inside = document.querySelector(".inside svg .reveal");
  const syncInside = () => {
    if (!inside) return;
    const svg = inside.ownerSVGElement.getBoundingClientRect();
    inside.ownerSVGElement.querySelectorAll("rect").forEach((r) => {
      r.setAttribute("width", String(Math.max(0, svg.width - 2)));
      r.setAttribute("height", String(Math.max(0, svg.height - 2)));
    });
  };
  syncInside();
  window.addEventListener("resize", syncInside);

  // Without GSAP (blocked, offline) or with reduced motion: the settled state, and simple step tracking.
  const gsap = window.gsap;
  if (!gsap || !window.ScrollTrigger || reduce) {
    document.documentElement.classList.add("settled");
    document.querySelectorAll('.slip[data-fate="fit"]').forEach((s) => (s.style.visibility = "hidden"));
    document.querySelectorAll(".stamp, .fitted__note").forEach((s) => (s.style.opacity = "1"));
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && activate(steps.indexOf(e.target))), { rootMargin: "-45% 0px -45% 0px" });
      steps.forEach((s) => io.observe(s));
    }
    window.addEventListener("resize", placeLine);
    return;
  }

  gsap.registerPlugin(window.ScrollTrigger, window.DrawSVGPlugin);
  const ST = window.ScrollTrigger;

  /* ---------- Hero: the pile, then the fit ---------- */
  const mark = document.querySelector(".mark");
  const frame = mark.querySelector(".mark__frame");
  const cursor = mark.querySelector(".mark__cursor");
  const note = document.querySelector(".fitted__note");
  const toggle = document.querySelector(".motion-toggle");
  const PIN = "#f07a63";
  const TAPE = "#e9b872";
  let tl;
  let userPaused = false;

  const buildHero = () => {
    if (tl) tl.kill();
    placeLine();
    const slips = [...document.querySelectorAll(".slip")].filter((s) => s.offsetParent !== null);
    const fits = slips.filter((s) => s.dataset.fate === "fit");
    const secret = slips.find((s) => s.dataset.fate === "secret");
    const stamp = secret?.querySelector(".stamp");
    const h = hero.getBoundingClientRect();
    const cx = h.left + h.width / 2;
    const cy = h.top + h.height / 2;
    const towardCenter = (el, axis) => {
      const r = el.getBoundingClientRect();
      return axis === "x" ? (cx - (r.left + r.width / 2)) * 0.55 : (cy - (r.top + r.height / 2)) * 0.55;
    };

    gsap.set(slips, { autoAlpha: 0, scale: 0.92, y: 18, x: 0 });
    gsap.set(lineRect, { drawSVG: "0%" });
    if (stamp) gsap.set(stamp, { autoAlpha: 0, scale: 1.6 });
    gsap.set(note, { autoAlpha: 0, y: 8 });
    gsap.set(frame, { stroke: TAPE, strokeDashoffset: 0 });

    tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6, defaults: { ease: "power2.out" } });

    // 1. The pile: one prompt or error after another, and the mark gets anxious.
    tl.to(slips, { autoAlpha: 1, scale: 1, y: 0, duration: 0.55, ease: "back.out(1.7)", stagger: { each: 0.5, from: "random" } }, 0.3);
    tl.to(frame, { strokeDashoffset: -216, duration: slips.length * 0.5 + 0.6, ease: "power1.in" }, 0.3);
    tl.to(frame, { stroke: PIN, duration: slips.length * 0.5, ease: "none" }, 0.3);
    tl.to(mark, { keyframes: { x: [0, -2, 2, -1.5, 1.5, 0], rotation: [0, -1.5, 1.5, -1, 1, 0] }, duration: 0.5, repeat: 3 }, slips.length * 0.5 - 1.4);

    // 2. The fit: the line draws itself around the work, the allowed things settle inside it.
    tl.addLabel("fit", "+=0.5");
    tl.to(frame, { stroke: TAPE, duration: 0.45 }, "fit");
    tl.to(lineRect, { drawSVG: "100%", duration: 1.15, ease: "power2.inOut" }, "fit");
    tl.to(fits, { x: (i, el) => towardCenter(el, "x"), y: (i, el) => towardCenter(el, "y"), scale: 0.5, autoAlpha: 0, duration: 0.75, ease: "power3.in", stagger: 0.05 }, "fit+=0.25");
    if (secret) {
      tl.to(secret, { rotation: -6, y: -6, duration: 0.6, ease: "power3.out" }, "fit+=0.7");
      tl.to(stamp, { autoAlpha: 1, scale: 1, duration: 0.4, ease: "back.out(3)" }, "fit+=1.15");
    }
    tl.to(cursor, { autoAlpha: 0, duration: 0.01, repeat: 7, yoyo: true, repeatDelay: 0.45 }, "fit+=1.3");
    tl.to(note, { autoAlpha: 1, y: 0, duration: 0.5 }, "fit+=1.35");

    // 3. Hold the calm, then clear for the next round.
    tl.to({}, { duration: 4.2 });
    tl.to([secret, note].filter(Boolean), { autoAlpha: 0, duration: 0.5 });
    tl.to(lineRect, { drawSVG: "100% 100%", duration: 0.6, ease: "power2.in" }, "<");
    if (secret) tl.set(secret, { rotation: (i, el) => el.style.getPropertyValue("--r") || 0, y: 0 });

    if (userPaused) tl.pause();
  };

  buildHero();

  toggle.hidden = false;
  toggle.addEventListener("click", () => {
    userPaused = !userPaused;
    toggle.setAttribute("aria-pressed", String(userPaused));
    toggle.textContent = userPaused ? "Play animation" : "Pause animation";
    userPaused ? tl.pause() : tl.play();
  });

  // Don't animate what nobody can see.
  ST.create({ trigger: hero, start: "top bottom", end: "bottom top", onToggle: (self) => (self.isActive && !userPaused ? tl.play() : tl.pause()) });

  let resizeTimer;
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return; // ignore mobile address-bar height changes
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(buildHero, 200);
  });

  // The headline's own entrance: once, on load.
  gsap.from(".hero h1 span", { yPercent: 40, autoAlpha: 0, duration: 0.9, ease: "power3.out", stagger: 0.12, delay: 0.1 });
  gsap.from([".hero__lede", ".hero .install", ".hero__after"], { y: 16, autoAlpha: 0, duration: 0.7, ease: "power2.out", stagger: 0.1, delay: 0.45 });

  /* ---------- Scroll cues ---------- */
  // The ruler fills as you read.
  gsap.to(".ruler__progress", { scaleX: 1, ease: "none", scrollTrigger: { start: 0, end: "max", scrub: 0.3 } });

  // Tape measures run out to their real length, and the numbers count with them.
  document.querySelectorAll(".tape").forEach((tape) => {
    const fill = tape.querySelector(".tape__fill");
    const num = tape.querySelector("[data-count]");
    const target = parseFloat(num.dataset.count);
    const decimals = String(num.dataset.count).includes(".") ? 1 : 0;
    const counter = { v: 0 };
    const tlTape = gsap.timeline({ scrollTrigger: { trigger: tape, start: "top 82%", once: true } });
    tlTape.from(fill, { scaleX: 0, duration: 1.3, ease: "power3.out" }, 0);
    tlTape.to(counter, { v: target, duration: 1.3, ease: "power3.out", onUpdate: () => (num.textContent = `${counter.v.toFixed(decimals)}%`) }, 0);
  });

  // The boundary around what's allowed draws once, when it comes into view.
  if (inside) {
    gsap.from(inside, { drawSVG: "0%", duration: 1.6, ease: "power2.inOut", scrollTrigger: { trigger: ".line-diagram", start: "top 75%", once: true } });
  }

  // Steps: whichever is in the middle of the screen drives the terminal.
  steps.forEach((step, i) => {
    ST.create({ trigger: step, start: "top 55%", end: "bottom 55%", onToggle: (self) => self.isActive && activate(i) });
  });
})();
