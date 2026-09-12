# EIF demo video

Use a short AI-generated conceptual opener, then cut to a real screen recording
of Dendrite and the Fabric dashboard. The opener is an illustration, not a
recording of working software or a benchmark.

## Oxen generation

Submitted on 2026-09-12 through the repository's `bin/oxen` gateway:

- Model: `kling-video-v2-6-pro-text-to-video` (Kling 2.6 Pro).
- Format: five seconds, landscape 16:9, with generated instrumental music.
- Generation ID: `2a6f75ad-a219-4a65-a737-7c12f4995499`.
- Catalog price at submission: $0.14 per output second with audio; approximately
  $0.70 for one five-second clip, not a confirmed final charge.
- Source: [Oxen video catalog](https://www.oxen.ai/ai/models?categories=video).
- Status: succeeded. Downloaded MP4 verified as H.264, 1920×1080, approximately
  5.04 seconds, with a stereo AAC audio track. The local delivery copy normalizes
  the initially quiet audio toward −18 LUFS and preserves the original video
  stream. Sampled frames were visually inspected. Audio playback is unsupported
  in this agent session, so the soundtrack still needs a human listening check.

### Prompt

> Create a polished five-second opening shot for an enterprise technology demo.
> Landscape 16:9. A precise, cinematic 3D architectural view of a contemporary
> office: three ordinary laptops and two desktop computers on desks, brushed
> aluminum and charcoal surfaces, warm natural daylight, restrained cyan accents.
> Start with the computers quietly idle. A small abstract agent task splits into
> several distinct luminous packets that travel along clean fine network lines to
> the computers; subtle CPU activity appears, then completed packets return to
> the central task. A calm smooth camera push-in, confident and credible
> engineering aesthetic. Visual metaphor for using spare CPU capacity for small
> AI inference jobs. Keep all devices recognizable and stable. No readable screen
> UI, text, logos, statistics, robots, server farms, or exaggerated energy effects.
> Soundtrack: original uplifting instrumental electronic technology music, warm
> synth arpeggio, soft pulsing bass and light percussion, clean optimistic
> progression and a short resolved finish. Music only; no voice, lyrics, dialogue
> or sound effects.

Parameters:

```json
{
  "duration": 5,
  "aspect_ratio": "16:9",
  "generate_audio": true,
  "negative_prompt": "illegible typography, captions, numbers, neon cyberpunk, holographic people, robots, distorted computers, camera shake, watermark, speech, singing"
}
```

Generated audio is probabilistic: verify the returned clip actually contains
suitable music before using it. Do not call it musically reviewed from the
presence of an audio stream alone.

## Screen-recording handoff

Add the EIF title in the video editor, not inside the generation prompt, so it is
spelled correctly and remains readable. Suggested opening line:

> Your next source of AI compute is already on your desks.

Continue over the real screen recording:

> Companies already own computers with spare capacity. Elastic Inference Fabric
> connects those resources through Dendrite, running small inference tasks on
> available CPUs so agents can make progress on bigger jobs. Here are our nodes,
> the models they actually have loaded, and a task returning a real result.

Record the actual node inventory, submit one bounded task, and show the returned
result and node that handled it. Describe tokens per second as the last measured
sample, not guaranteed capacity. Do not imply a large model is split across
machines, that cache transfer is supported, or that every listed model is
resident. Keep access tokens, ownership emails and private prompts off-screen.

Keep the opener's music below narration, or fade it out when the live demo
starts. Do not add a third-party commercial song without permission.
