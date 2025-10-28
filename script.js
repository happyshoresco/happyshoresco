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
