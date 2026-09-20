import { useEffect, useRef } from 'react';

export function MotionLayer({ route }: { route: string }) {
  const progress = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const elements = [...document.querySelectorAll<HTMLElement>('.public-site main > section, .feature-grid article, .steps-grid article, .doc-card, .pool-capabilities > div')];
    const observer = new IntersectionObserver(entries => { entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('revealed'); observer.unobserve(entry.target); } }); }, { threshold: 0.08, rootMargin: '0px 0px -22px 0px' });
    elements.forEach((el, i) => { el.classList.add('reveal'); el.style.setProperty('--reveal-delay', `${el.matches('article,.doc-card') ? i % 3 * 75 : 0}ms`); observer.observe(el); });
    const main = document.querySelector('.dashboard-content');
    const animation = main?.animate([{opacity: .35, transform:'translateY(10px)'},{opacity:1, transform:'translateY(0)'}], {duration:320,easing:'cubic-bezier(.2,.65,.3,1)'});
    return () => { observer.disconnect(); animation?.cancel(); elements.forEach(el=>el.classList.remove('reveal','revealed')); };
  }, [route]);
  useEffect(() => {
    let frame = 0;
    const update = () => { cancelAnimationFrame(frame); frame=requestAnimationFrame(()=>{if(progress.current) {const total=document.documentElement.scrollHeight-innerHeight;progress.current.style.transform=`scaleX(${total>0?Math.min(1,scrollY/total):0})`;}}); };
    window.addEventListener('scroll',update,{passive:true});update();return()=>{window.removeEventListener('scroll',update);cancelAnimationFrame(frame);};
  },[]);
  return <div className="reading-progress" ref={progress} aria-hidden="true"/>;
}
