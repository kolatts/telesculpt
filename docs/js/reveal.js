// reveal.js — the payoff. Walks every chain step by step, locally (each
// player advances their own reveal with the Next button). Text steps show as
// speech-bubble cards; sculpture steps render in the turntable viewer.
// Small canvas confetti burst at the end of each chain, bigger at the end.

import { Viewer } from './viewer.js';

// ------------------------------------------------------------------ confetti

const CONFETTI_COLORS = ['#e63946', '#f4a261', '#e9c46a', '#2a9d8f', '#a8dadc', '#ffffff', '#6d597a'];
let confettiRunning = false;

export function confettiBurst(canvas, count = 90) {
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const parts = [];
  for (let i = 0; i < count; i++) {
    parts.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * canvas.width * 0.3,
      y: canvas.height * 0.35,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 13 - 4,
      w: 6 + Math.random() * 6,
      h: 4 + Math.random() * 4,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.4,
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
      life: 1,
    });
  }
  const started = performance.now();
  confettiRunning = true;
  function frame(now) {
    const t = (now - started) / 1000;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = 0;
    for (const p of parts) {
      p.vy += 0.35;
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.99;
      p.rot += p.vr;
      p.life = Math.max(0, 1 - t / 2.4);
      if (p.y < canvas.height + 20 && p.life > 0) {
        alive++;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
    }
    if (alive > 0 && t < 3) {
      requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      confettiRunning = false;
    }
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ flow

/**
 * els: {
 *   progress, cardArea, viewerWrap, viewerHost, sculptorName,
 *   nextBtn, finalPanel, playAgainBtn, confettiCanvas
 * }
 */
export class RevealFlow {
  constructor(els, data, { onPlayAgain } = {}) {
    this.els = els;
    this.chains = (data && data.chains) || [];
    this.chain = 0;
    this.step = 0;
    this.viewer = null;
    this.done = false;
    this._onNext = () => this.next();
    els.nextBtn.addEventListener('click', this._onNext);
    if (els.playAgainBtn && onPlayAgain) {
      els.playAgainBtn.addEventListener('click', onPlayAgain, { once: true });
    }
  }

  start() {
    this.chain = 0;
    this.step = 0;
    this.done = false;
    this.els.finalPanel.classList.add('hidden');
    this.els.nextBtn.classList.remove('hidden');
    this._showStep();
  }

  _ensureViewer() {
    if (!this.viewer) {
      this.viewer = new Viewer(this.els.viewerHost);
    }
    this.viewer.start();
    return this.viewer;
  }

  async _showStep() {
    const { els } = this;
    const chain = this.chains[this.chain];
    if (!chain) { this._finish(); return; }
    const step = chain.steps[this.step];
    if (!step) { this._finish(); return; }

    els.progress.textContent = `Chain ${this.chain + 1} of ${this.chains.length}`;

    const isLastStepOfChain = this.step === chain.steps.length - 1;
    const isLastChain = this.chain === this.chains.length - 1;
    els.nextBtn.textContent = isLastStepOfChain
      ? (isLastChain ? 'Finish' : 'Next chain')
      : 'Next';

    if (step.type === 'text') {
      els.viewerWrap.classList.add('hidden');
      if (this.viewer) this.viewer.stop();
      const label = this.step === 0 ? 'started with' : 'guessed';
      const card = document.createElement('div');
      card.className = 'reveal-card bubble-in';
      card.innerHTML = `
        <div class="reveal-author">
          <span class="dot" style="background:${escapeAttr(step.playerColor)}"></span>
          <span class="reveal-author-name"></span>
          <span class="reveal-author-verb">${label}</span>
        </div>
        <div class="reveal-text"></div>`;
      card.querySelector('.reveal-author-name').textContent = step.playerName || '???';
      card.querySelector('.reveal-text').textContent = `“${step.text || '…'}”`;
      els.cardArea.replaceChildren(card);
      els.cardArea.classList.remove('hidden');
    } else {
      // sculpture step
      els.cardArea.classList.add('hidden');
      els.viewerWrap.classList.remove('hidden');
      els.sculptorName.innerHTML = `<span class="dot" style="background:${escapeAttr(step.playerColor)}"></span> <b></b> sculpted this`;
      els.sculptorName.querySelector('b').textContent = step.playerName || '???';
      const viewer = this._ensureViewer();
      try {
        await viewer.loadUrl(step.blobUrl);
      } catch {
        viewer.load({ voxels: [] });
        els.sculptorName.innerHTML += ' <i>(failed to load)</i>';
      }
    }
  }

  next() {
    if (this.done) return;
    const chain = this.chains[this.chain];
    if (!chain) { this._finish(); return; }
    if (this.step < chain.steps.length - 1) {
      this.step++;
      this._showStep();
    } else {
      // End of a chain: confetti!
      confettiBurst(this.els.confettiCanvas);
      if (this.chain < this.chains.length - 1) {
        this.chain++;
        this.step = 0;
        this._showStep();
      } else {
        this._finish();
      }
    }
  }

  _finish() {
    this.done = true;
    this.els.cardArea.classList.add('hidden');
    this.els.viewerWrap.classList.add('hidden');
    if (this.viewer) this.viewer.stop();
    this.els.nextBtn.classList.add('hidden');
    this.els.progress.textContent = 'That’s the whole story!';
    this._renderSummary();
    this.els.finalPanel.classList.remove('hidden');
    confettiBurst(this.els.confettiCanvas, 160);
  }

  // The punchline: each chain's opening phrase next to where it ended up.
  _renderSummary() {
    const host = this.els.finalPanel.querySelector('#final-summary');
    if (!host) return;
    host.replaceChildren();
    for (const chain of this.chains) {
      const first = chain.steps[0];
      const lastText = [...chain.steps].reverse().find((s) => s.type === 'text' && s !== first);
      const row = document.createElement('div');
      row.className = 'summary-row';
      const from = document.createElement('span');
      from.className = 'summary-from';
      from.textContent = `“${first?.text || '…'}”`;
      const arrow = document.createElement('span');
      arrow.className = 'summary-arrow';
      arrow.textContent = '→';
      const to = document.createElement('span');
      to.className = 'summary-to';
      to.textContent = lastText ? `“${lastText.text || '…'}”` : '🗿';
      row.append(from, arrow, to);
      host.appendChild(row);
    }
  }

  dispose() {
    this.els.nextBtn.removeEventListener('click', this._onNext);
    if (this.viewer) { this.viewer.dispose(); this.viewer = null; }
  }
}

function escapeAttr(s) {
  return String(s || '#888').replace(/[^#a-zA-Z0-9(),.% -]/g, '');
}
