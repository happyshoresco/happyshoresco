// Mobile menu3
const toggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('.nav');
if (toggle) {
  toggle.addEventListener('click', () => nav.classList.toggle('open'));
}
// Close menu on link click (mobile)
document.querySelectorAll('.nav__links a').forEach(a=>{
  a.addEventListener('click', ()=> nav.classList.remove('open'));
});

// Year in footer
document.getElementById('year').textContent = new Date().getFullYear();
// FAQ accordion toggle
const faqItems = document.querySelectorAll(".faq-item");

faqItems.forEach(item => {
  const question = item.querySelector(".faq-question");
  question.addEventListener("click", () => {
    item.classList.toggle("active");
    faqItems.forEach(other => {
      if (other !== item) other.classList.remove("active");
    });
  });
});
// Scroll-reveal for FAQ items (replays on every scroll)
(() => {
  const items = Array.from(document.querySelectorAll(".faq-item"));
  if (!items.length || !("IntersectionObserver" in window)) return;

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const el = entry.target;
        const idx = items.indexOf(el);
        // Stagger delay by index (caps at 600ms)
        el.style.setProperty("--delay", `${Math.min(idx * 100, 600)}ms`);

        if (entry.isIntersecting) {
          el.classList.add("in-view");     // fade/slide IN when visible
        } else {
          el.classList.remove("in-view");  // reset when it leaves, so it can animate again next time
        }
      });
    },
    { root: null, rootMargin: "0px 0px -10% 0px", threshold: 0.15 }
  );

  items.forEach((el) => io.observe(el));
})();

