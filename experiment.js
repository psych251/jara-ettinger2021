/*
 * Replication of Experiment 1 of Jara-Ettinger & Rubio-Fernandez (2021), "Quantitative mental
 * state attributions in language understanding", Science Advances 7(47), eabj0970.
 * Materials and procedure follow the authors' OSF archive (h8qfy) and the Supplementary Materials.
 *
 * Design summary
 *   IV:        trial type (28 pairs of displays crossing description type x contrast shape x
 *              overlap; Tables S1-S2), within subjects. Each participant sees one of two lists of
 *              14 trials (Table S4), randomly assigned (`condition` = "list1" / "list2").
 *   DVs:       three 2D trackpads per trial (task "trial"): referent in display A (ref_a_x/y),
 *              referent in display B (ref_b_x/y), and the speaker's blind spot (cg_x/y). All in
 *              canonical orientation, 0-1, x left->right, y top->bottom (as in the original data).
 *              Raw on-screen positions are kept as screen_lref_*, screen_rref_*, screen_cg_*.
 *   Structure: tutorial (the original 14 slides) -> 6-question comprehension check, repeated until
 *              all answers are correct -> 14 trials, self-paced, no time limit.
 *   Random:    trial order shuffled per participant; on every trial the two displays are randomly
 *              ordered left/right (left_counterbalance: 1 = A on the left, as in the original) and
 *              rotated 0-3 quarter turns clockwise (stim_rotation, same coding as the original).
 *   Exclusion: none beyond passing the comprehension check (as in the original Exp. 1).
 *              quiz attempts are recorded (task "quiz": attempt, n_wrong, passed).
 *
 * Timeline: consent -> preload -> welcome -> [tutorial -> quiz]* -> trials -> age -> comments -> debrief
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
window.TEMPLATE_VERSION = "0.1.0";

const EXPERIMENT = {
  // Firestore path: experiments/<id>/participants/... Change it when you start a new study
  // so pilot data and real data never mix (e.g. "smith2016-pilot-a", "smith2016-final").
  id: "jara-ettinger2021-pilot-a",

  // Trials per Firestore write. 1 = save every trial the moment it finishes (dropouts leave
  // partial data). About 25 writes per participant at 1, far inside the free tier.
  chunk_size: 1,

  // Also store the complete jsPsych dataset on the participant document at the end.
  // Costs one extra write and makes export robust; turn off if trials are very large.
  save_full_data_at_end: true,

  // Prolific: if set, participants are redirected to Prolific when they finish.
  // Leave empty for local testing or non-Prolific samples.
  prolific_completion_code: "",

  // Contact shown in consent and debrief.
  contact_email: "stanfordpsych251@gmail.com",

  // Turns away devices without a mouse or trackpad (phones, tablets) before consent. This study
  // uses no keys, but the 2D trackpads need a precise pointer and a wide screen, so keep it true.
  requires_keyboard: true,
};

// True on anything with a mouse, trackpad, or stylus, including laptops with touchscreens.
// False on phones and tablets without a pointing device, which are also the devices with no
// physical keyboard. See docs/student-guide.md "Devices".
function hasFinePointer() {
  return !!(window.matchMedia && window.matchMedia("(any-pointer: fine)").matches);
}

// `?emulator=1` in the URL sends data to the local emulator instead of the real project.
// Used by `npm test`; handy for development too (start it with `npm run emulators`).
const URL_PARAMS = new URLSearchParams(window.location.search);
const USE_EMULATOR = URL_PARAMS.get("emulator") === "1";
// `?chunk_size=N` overrides the setting above; used by the test suite to exercise chunked writes.
const CHUNK_SIZE = Number(URL_PARAMS.get("chunk_size")) || EXPERIMENT.chunk_size;
// Test-only: `?cc=CODE` sets a Prolific completion code during emulator runs, so the test
// suite can check the screen a participant sees once you have set yours. Ignored in live runs.
if (USE_EMULATOR && URL_PARAMS.get("cc")) EXPERIMENT.prolific_completion_code = URL_PARAMS.get("cc");

// ---------------------------------------------------------------------------
// Stimulus drawing and trackpad geometry
// ---------------------------------------------------------------------------
const COLORS = { red: "#e5362b", green: "#4caf50", blue: "#4472c4", yellow: "#fde047" };

function shapeSvg(cell) {
  const [color, shape] = cell.split(" ");
  const fill = COLORS[color];
  const body = {
    circle: `<circle cx="50" cy="50" r="40"/>`,
    square: `<rect x="12" y="12" width="76" height="76"/>`,
    triangle: `<polygon points="50,10 92,88 8,88"/>`,
    star: `<polygon points="50,6 61,38 95,38 67,58 78,92 50,71 22,92 33,58 5,38 39,38"/>`,
  }[shape];
  return `<svg viewBox="0 0 100 100" fill="${fill}" data-cell="${cell}">${body}</svg>`;
}

// Screen position (col, row), each 0 or 1, back to canonical: one counterclockwise quarter turn
// per clockwise rotation applied. Works for any point in the unit square, so it also maps
// trackpad positions back to canonical orientation (as Exp1_ProcessRawData.R does).
function unrotate(x, y, quarterTurns) {
  for (let k = 0; k < quarterTurns; k++) [x, y] = [y, 1 - x];
  return [x, y];
}

// The grid as shown: canonical cells permuted by the rotation (shapes stay upright).
function gridHtml(label, display, rotation) {
  const cells = [];
  for (const [col, row] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const [c, r] = unrotate(col, row, rotation);
    cells.push(`<div class="cell">${shapeSvg(display.cells[r * 2 + c])}</div>`);
  }
  return `<div class="display">
      <div class="display-label">${label}</div>
      <div class="utterance">${display.utterance}</div>
      <div class="grid">${cells.join("")}</div>
    </div>`;
}

// Original trackpads: 100 px square, 15 px marker, so the marker centre ranges over 7.5-92.5 px.
const PAD = 100, DOT = 15, MIN = DOT / 2, RANGE = PAD - DOT;

function padHtml(name, prompt) {
  return `<div class="pad-block"><div class="pad-prompt">${prompt}</div>
    <div class="pad" data-pad="${name}" style="width:${PAD}px;height:${PAD}px">
      <div class="pad-dot" style="width:${DOT}px;height:${DOT}px;left:${PAD / 2 - MIN}px;top:${PAD / 2 - MIN}px"></div>
    </div></div>`;
}

// Wire every .pad on the page; returns the live state { name: { x, y, touched } } with x, y in 0-1.
function wirePads(root) {
  const state = {};
  root.querySelectorAll(".pad").forEach((pad) => {
    const name = pad.dataset.pad;
    const dot = pad.querySelector(".pad-dot");
    state[name] = { x: 0.5, y: 0.5, touched: false };
    const move = (e) => {
      const box = pad.getBoundingClientRect();
      const cx = Math.min(Math.max(e.clientX - box.left, MIN), PAD - MIN);
      const cy = Math.min(Math.max(e.clientY - box.top, MIN), PAD - MIN);
      dot.style.left = cx - MIN + "px";
      dot.style.top = cy - MIN + "px";
      state[name] = { x: (cx - MIN) / RANGE, y: (cy - MIN) / RANGE, touched: true };
    };
    pad.addEventListener("pointerdown", (e) => { pad.setPointerCapture(e.pointerId); move(e); e.preventDefault(); });
    pad.addEventListener("pointermove", (e) => { if (pad.hasPointerCapture(e.pointerId)) move(e); });
  });
  return state;
}

// ---------------------------------------------------------------------------
// Boot: connect the saver first so even a crash in the first trial gets logged.
// ---------------------------------------------------------------------------
(async function main() {
  const deviceSupported = !EXPERIMENT.requires_keyboard || hasFinePointer();

  const saver = await DataSaver.init({
    experiment_id: EXPERIMENT.id,
    chunk_size: CHUNK_SIZE,
    save_full_data_at_end: EXPERIMENT.save_full_data_at_end,
    use_emulator: USE_EMULATOR,
    contact_email: EXPERIMENT.contact_email,
  });
  window.__saver = saver; // for debugging and the automated test

  // Record the device verdict on the participant document before anything else, so a
  // participant turned away below is still visible in the data rather than simply absent.
  saver.updateParticipant({ device_supported: deviceSupported, requires_keyboard: EXPERIMENT.requires_keyboard });

  if (!deviceSupported) {
    document.body.innerHTML =
      '<div id="device-unsupported" class="jspsych-content" style="max-width:640px;margin:15vh auto;font:16px/1.6 system-ui,sans-serif;">' +
      "<h2>Please use a computer</h2>" +
      "<p>This study needs a computer with a mouse or trackpad, because you answer by dragging " +
      "markers on the screen. Phones and tablets cannot be used.</p>" +
      "<p>Please reopen this link on a laptop or desktop computer. If you were sent here from " +
      "Prolific, you can return the study and take it later on a computer; nothing has been recorded " +
      "against you.</p>" +
      "<p>Questions: <a href=\"mailto:" + EXPERIMENT.contact_email + "\">" + EXPERIMENT.contact_email + "</a></p></div>";
    return;
  }

  const jsPsych = initJsPsych({
    show_progress_bar: true,
    // Updated by hand (setProgress below): the automatic count treats the tutorial/quiz loop
    // and the conditional retry notice as one fixed step each, so it filled at the wrong time.
    auto_update_progress_bar: false,
    on_data_update: (trial) => saver.onTrial(trial),
    on_finish: async () => {
      const el = jsPsych.getDisplayElement();
      el.innerHTML = '<div id="finish-message"><p class="thanks">Saving your responses…</p></div>';
      // finish() flushes remaining trials, marks the participant complete, and (only if
      // saving failed) appends a download-fallback box to the display element.
      const result = await saver.finish(jsPsych);
      const consentRow = jsPsych.data.get().filter({ task: "consent" }).values()[0];
      const consented = !consentRow || consentRow.consented !== false;
      const msg = document.getElementById("finish-message");

      if (!consented) {
        msg.innerHTML = "<h2 class='thanks'>Thank you</h2><p class='thanks'>You chose not to participate. " +
          "You may close this window" + (EXPERIMENT.prolific_completion_code ? " and return the study on Prolific" : "") + ".</p>";
        return;
      }
      if (result.ok && EXPERIMENT.prolific_completion_code && !USE_EMULATOR) {
        msg.innerHTML = "<p class='thanks'>Saved. Returning you to Prolific…</p>";
        window.location.href =
          "https://app.prolific.com/submissions/complete?cc=" + EXPERIMENT.prolific_completion_code;
        return;
      }
      // In emulator/test runs we stay on the page instead of navigating to Prolific, so that
      // setting a completion code can never turn `npm test` or CI red. Live runs redirect above.
      msg.innerHTML =
        "<h2 class='thanks'>All done</h2>" +
        (result.ok ? "<p class='thanks'>Your responses were saved. Thank you for participating!</p>" : "") +
        (EXPERIMENT.prolific_completion_code
          ? "<p class='thanks'>Your completion code is <strong>" + EXPERIMENT.prolific_completion_code + "</strong>.</p>"
          : "");
    },
  });

  // Progress: 5% after the welcome, 15% once the quiz is passed, then the 14 trials up to 90%.
  const setProgress = (p) => { jsPsych.progressBar.progress = p; };

  // Record the participant id and URL parameters on every trial row.
  jsPsych.data.addProperties({
    // Must be the run-scoped document id, so trial rows join to participants.csv on export.
    participant_id: saver.docId,
    prolific_pid: saver.params.PROLIFIC_PID || null,
    experiment_id: EXPERIMENT.id,
  });

  // Random assignment to one of the two 14-trial lists (Table S4), recorded on every trial and
  // on the participant document. The original had n = 30 per list; random assignment will not
  // balance exactly at course sample sizes.
  const list = jsPsych.randomization.sampleWithoutReplacement([1, 2], 1)[0];
  const condition = "list" + list;
  jsPsych.data.addProperties({ condition: condition });
  saver.updateParticipant({ condition: condition });

  // -------------------------------------------------------------------------
  // 1. Consent (course-wide IRB text; edit only the contact address)
  // -------------------------------------------------------------------------
  const consent = {
    type: jsPsychHtmlButtonResponse,
    stimulus: `
      <div class="consent">
        <h2>Consent</h2>
        <p>By answering the following questions, you are participating in a study being performed by
        cognitive scientists in the Stanford Department of Psychology. If you have questions about
        this research, please contact us at <a href="mailto:${EXPERIMENT.contact_email}">${EXPERIMENT.contact_email}</a>.
        You must be at least 18 years old to participate. Your participation in this research is
        voluntary. You may decline to answer any or all of the following questions. You may decline
        further participation, at any time, without adverse consequences. Your anonymity is assured;
        the researchers who have requested your participation will not receive any personal
        information about you.</p>
      </div>`,
    choices: ["I agree to participate", "I do not agree"],
    data: { task: "consent" },
    on_finish: (data) => {
      data.consented = data.response === 0;
      if (!data.consented) {
        // No end message here: jsPsych would paint it over the screen that on_finish renders.
        jsPsych.abortExperiment();
      }
    },
  };

  // -------------------------------------------------------------------------
  // 2. Preload the tutorial slides
  // -------------------------------------------------------------------------
  const tutorialImages = Array.from({ length: 14 }, (_, i) => `stimuli/tutorial/${i + 1}.jpg`);
  const preload = {
    type: jsPsychPreload,
    images: tutorialImages,
    data: { task: "preload" },
  };

  // -------------------------------------------------------------------------
  // 3. Welcome, tutorial (the original slides), and comprehension check
  // -------------------------------------------------------------------------
  const welcome = {
    type: jsPsychInstructions,
    pages: [
      `<h2>Welcome</h2>
       <p>In this study you will read a short tutorial, answer a few questions about it, and then
       complete 14 puzzles about what a speaker meant. It takes about 20 minutes.</p>
       <p>Please complete the study in one sitting, in a quiet place, on a laptop or desktop
       computer with a mouse or trackpad. Use the buttons or the arrow keys to move between pages.</p>`,
    ],
    show_clickable_nav: true,
    button_label_next: "Continue",
    data: { task: "instructions" },
    on_finish: () => setProgress(0.05),
  };

  const tutorial = {
    type: jsPsychInstructions,
    pages: tutorialImages.map((src) => `<img class="tutorial-slide" src="${src}" alt="Tutorial slide">`),
    show_clickable_nav: true,
    button_label_next: "Continue",
    data: { task: "tutorial" },
  };

  // Questions and options as on the original screen (Procedure_screenshots/Exp1_InclusionQuestionnaire.png).
  const quizQuestions = [
    { name: "q1", title: "You will...", correct: "b",
      choices: ["give instructions to a virtual partner.", "follow the instructions of a virtual partner."] },
    { name: "q2", title: "My virtual partner...", correct: "b",
      choices: ["sees all four corners.", "sees only three corners."] },
    { name: "q3", title: "My virtual partner's blind spot...", correct: "a",
      choices: ["is the same in each pair of events, but different across trials.", "is always different across events and trials."] },
    { name: "q4", title: "My virtual partner...", correct: "b",
      choices: ["knows that he has a blind spot.", "does not know about his blind spot."] },
    { name: "q5", title: "My virtual partner...", correct: "a",
      choices: ["is always trying to be helpful.", "will sometimes mislead me on purpose."] },
    { name: "q6", title: "I will figure out what my virtual partner can see by...", correct: "c",
      choices: ["looking at all four figures.", "looking at what the virtual partner says.", "looking at both."] },
  ];
  let quizAttempt = 0;
  let quizPassed = false;
  const quiz = {
    type: jsPsychSurvey,
    survey_json: {
      title: "Let's make sure it's all clear!",
      description: "Please answer the following questions carefully. If you respond incorrectly we will ask you to read the instructions again.",
      showQuestionNumbers: "on",
      completeText: "Continue",
      pages: [{
        elements: quizQuestions.map((q) => ({
          type: "radiogroup", name: q.name, title: q.title, isRequired: true,
          choices: q.choices.map((text, i) => ({ value: "abc"[i], text: `${"abc"[i]}) ${text}` })),
        })),
      }],
    },
    data: { task: "quiz" },
    on_finish: (data) => {
      quizAttempt += 1;
      data.attempt = quizAttempt;
      data.n_wrong = quizQuestions.filter((q) => data.response[q.name] !== q.correct).length;
      data.passed = data.n_wrong === 0;
      quizPassed = data.passed;
      if (quizPassed) setProgress(0.15);
    },
  };
  const quizRetryNotice = {
    timeline: [{
      type: jsPsychHtmlButtonResponse,
      stimulus: `<p>At least one of your answers was incorrect. Please read the instructions again.</p>`,
      choices: ["Back to the instructions"],
      data: { task: "quiz_retry" },
    }],
    conditional_function: () => !quizPassed,
  };
  // Original procedure: anyone with a wrong answer goes back to the start of the tutorial.
  const tutorialLoop = {
    timeline: [tutorial, quiz, quizRetryNotice],
    loop_function: () => !quizPassed,
  };

  // -------------------------------------------------------------------------
  // 4. The 14 trials of the assigned list
  // -------------------------------------------------------------------------
  const listTrials = jsPsych.randomization.shuffle(window.EXP1_TRIALS.filter((t) => t.list === list))
    .map((t, i) => ({
      ...t,
      presentation_order: i,
      left_counterbalance: jsPsych.randomization.sampleWithoutReplacement([0, 1], 1)[0],
      stim_rotation: jsPsych.randomization.sampleWithoutReplacement([0, 1, 2, 3], 1)[0],
    }));

  let pads = null;
  const trial = {
    type: jsPsychHtmlButtonResponse,
    stimulus: () => {
      const t = jsPsych.evaluateTimelineVariable("item");
      const [left, right] = t.left_counterbalance === 1 ? [t.a, t.b] : [t.b, t.a];
      return `<div class="trial" data-model-trial="${t.model_trial}">
          <div class="displays">${gridHtml("A", left, t.stim_rotation)}${gridHtml("B", right, t.stim_rotation)}</div>
          <div class="pads">
            <div class="pad-row">
              ${padHtml("left", "Which corner is the speaker talking about in A?")}
              ${padHtml("right", "Which corner is the speaker talking about in B?")}
            </div>
            <div class="pad-row">${padHtml("cg", "Where is the blind spot?")}</div>
          </div>
        </div>`;
    },
    choices: ["Continue"],
    save_trial_parameters: { stimulus: false },
    on_load: () => { pads = wirePads(jsPsych.getDisplayElement()); },
    data: { task: "trial" },
    on_finish: (data) => {
      const t = jsPsych.evaluateTimelineVariable("item");
      Object.assign(data, {
        model_trial: t.model_trial, trial_id: t.trial_id, raw_trial_id: t.raw_trial_id, list: t.list,
        presentation_order: t.presentation_order, left_counterbalance: t.left_counterbalance,
        stim_rotation: t.stim_rotation, utterance_a: t.a.utterance, utterance_b: t.b.utterance,
      });
      // On-screen positions (labels A/B are the screen's left/right display).
      const screen = { lref: pads.left, rref: pads.right, cg: pads.cg };
      for (const [k, v] of Object.entries(screen)) {
        data[`screen_${k}_x`] = v.x;
        data[`screen_${k}_y`] = v.y;
        data[`${k}_touched`] = v.touched;
      }
      // Canonical: undo the left/right swap and the rotation, so A/B match the model's displays.
      const [refA, refB] = t.left_counterbalance === 1 ? [screen.lref, screen.rref] : [screen.rref, screen.lref];
      [data.ref_a_x, data.ref_a_y] = unrotate(refA.x, refA.y, t.stim_rotation);
      [data.ref_b_x, data.ref_b_y] = unrotate(refB.x, refB.y, t.stim_rotation);
      [data.cg_x, data.cg_y] = unrotate(screen.cg.x, screen.cg.y, t.stim_rotation);
      setProgress(0.15 + 0.75 * (t.presentation_order + 1) / listTrials.length);
    },
  };
  const trialsIntro = {
    type: jsPsychInstructions,
    pages: [
      `<h2>Ready?</h2>
       <p>You passed the questions. Now you will see the 14 trials. In each one, click or drag the
       markers to show which corner the speaker is talking about in each display and where you think
       the blind spot is. Press <strong>Continue</strong> when you are done with a trial.</p>`,
    ],
    show_clickable_nav: true,
    button_label_next: "Continue",
    data: { task: "instructions" },
  };
  const trials = {
    timeline: [trial],
    timeline_variables: listTrials.map((item) => ({ item })),
  };

  // -------------------------------------------------------------------------
  // 5. Age (the only demographic the original collected) and comments
  // -------------------------------------------------------------------------
  const demographics = {
    type: jsPsychSurvey,
    survey_json: {
      showQuestionNumbers: "off",
      completeText: "Continue",
      pages: [{
        elements: [
          // The consent text promises participants may decline any question, so this is not required.
          { type: "text", name: "age", title: "How old are you?", inputType: "number", min: 18, max: 120 },
        ],
      }],
    },
    data: { task: "demographics" },
    on_finish: () => setProgress(0.95),
  };
  const comments = {
    type: jsPsychSurveyText,
    questions: [{ prompt: "Any comments about the study? (optional)", name: "comments", rows: 4 }],
    data: { task: "feedback_text" },
    on_finish: () => setProgress(1),
  };

  // -------------------------------------------------------------------------
  // 6. Debrief
  // -------------------------------------------------------------------------
  const debrief = {
    type: jsPsychHtmlButtonResponse,
    stimulus: `
      <h2>Debrief</h2>
      <p>Thank you. This study looks at how people work out what a speaker can and cannot see from the
      words the speaker chooses, for example whether they mention a color when it is not needed. Your
      answers will be compared with the predictions of computational models of this reasoning. The
      speaker was simulated; there was no real partner. If you have questions about this research,
      contact <a href="mailto:${EXPERIMENT.contact_email}">${EXPERIMENT.contact_email}</a>.
      Press the button to save your responses and finish.</p>`,
    choices: ["Finish"],
    data: { task: "debrief" },
  };

  await jsPsych.run([
    consent,
    preload,
    welcome,
    tutorialLoop,
    trialsIntro,
    trials,
    demographics,
    comments,
    debrief,
  ]);
})();
