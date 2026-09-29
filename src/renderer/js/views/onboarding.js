'use strict';

const STEPS = [
  {
    title: 'Welcome to MVLP',
    body: 'Connect your iPixel LED panel to Multiviewer for F1 and Spotify. Live track status and album art, right on your desk.',
  },
  {
    title: 'Add your panel',
    body: 'Head to the Devices tab and click "Add Device". MVLP will scan for nearby iPixel panels over Bluetooth. Pick yours from the list.',
  },
  {
    title: 'Turn on integrations',
    body: 'From the Dashboard, flip on Multiviewer and/or Spotify. MVLP keeps them running quietly in the background, even minimized to the tray.',
  },
];

export function renderOnboarding(root, { onFinish }) {
  let step = 0;

  function paint() {
    const s = STEPS[step];
    const isLast = step === STEPS.length - 1;
    root.innerHTML = `
      <div class="modal onboarding-card">
        <div class="onboarding-mark"></div>
        <h2>${s.title}</h2>
        <p style="color:var(--text-dim);font-size:13.5px;line-height:1.6;">${s.body}</p>
        <div class="onboarding-steps">${STEPS.map((_, i) => `<span class="${i === step ? 'is-active' : ''}"></span>`).join('')}</div>
        <div class="modal-actions" style="width:100%;justify-content:center;">
          ${step > 0 ? '<button class="btn" id="ob-back">Back</button>' : ''}
          <button class="btn btn-primary" id="ob-next">${isLast ? 'Get Started' : 'Next'}</button>
        </div>
      </div>
    `;
    root.querySelector('#ob-back')?.addEventListener('click', () => { step--; paint(); });
    root.querySelector('#ob-next').addEventListener('click', async () => {
      if (isLast) {
        await window.mvlp.invoke('config:setSetting', 'onboardingComplete', true);
        onFinish();
      } else {
        step++;
        paint();
      }
    });
  }

  paint();
}
