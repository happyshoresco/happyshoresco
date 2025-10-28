// Mobile menu
const toggle = document.querySelector('.nav-toggle');
const menu = document.querySelector('.nav-menu');

if (toggle) {
  toggle.addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
}

// Close on link click (mobile)
document.querySelectorAll('.nav-menu a').forEach(a=>{
  a.addEventListener('click', ()=> menu.classList.remove('open'));
});

// Year in footer
document.getElementById('year').textContent = new Date().getFullYear();
