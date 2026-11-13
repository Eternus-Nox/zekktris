/**
 * ZekkPetArt
 * ----------
 * The Zekk Pet as an inline SVG, drawn from lib/petArt's primitives (the same
 * geometry the iOS and Android apps draw). Colours are the pet's own —
 * `color`: resolvePetColor(pet.color, pet.channelId) for a pet, a notice's
 * petColor (resolved the same way) for a notice — so both people see the
 * same pet whatever their themes. They go on the <svg> as the four
 * --zk-pet-* custom properties, which every shape inside reads; setting
 * --c-accent there would do nothing, since the --zk-pet-* defaults are
 * already worked out on :root. Art drawn without a colour keeps those :root
 * defaults (index.css), which follow the viewer's theme.
 *
 * Motion is CSS (index.css, `zk-pet-*`): an idle bob, a slow breathe while
 * asleep, a wobble on the egg; reduced-motion settings keep it still. The pet
 * card makes it react to a tap — `squash` (bump it per tap) restarts the
 * squash, and each id in `hearts` floats one heart up and away; the card
 * drops the id once the heart has faded.
 *
 * Fill and stroke go through `style`, not the SVG attributes: presentation
 * attributes don't resolve var().
 */

import { createElement, type CSSProperties } from 'react';
import type { PetMood, PetStage } from '@zekktris/client';
import { petHeartShapes, petMotion, petPalette, petShapes, type PetShape } from './petArt';

function renderShape(s: PetShape, key: number) {
  const { fill, stroke, ...rest } = s.attrs;
  const style: CSSProperties = {};
  if (fill !== undefined) style.fill = String(fill);
  if (stroke !== undefined) style.stroke = String(stroke);
  return createElement(s.tag, { key, ...rest, style });
}

/** The pet's colours as the custom properties its shapes read (a React
    style object: React sets it through the CSSOM, which the CSP allows).
    undefined without a known colour, leaving the :root defaults. */
function petColorStyle(color: string | null | undefined): CSSProperties | undefined {
  const p = petPalette(color);
  if (!p) return undefined;
  return {
    ['--zk-pet-body']: p.body,
    ['--zk-pet-belly']: p.belly,
    ['--zk-pet-outline']: p.outline,
    ['--zk-pet-accent']: p.accent,
  } as CSSProperties;
}

export function ZekkPetArt({
  stage,
  mood,
  color,
  progress = 0,
  size,
  animated = true,
  squash = 0,
  hearts,
  title,
  className = '',
}: {
  stage: PetStage;
  mood: PetMood;
  /** The pet's own colour (a PetColorId), the same for everyone who sees
      it. Without one, or with an id this app doesn't know, the art falls
      back to the :root colours (the viewer's theme). */
  color?: string | null;
  /** 0–1 towards the next level (cracks the egg near the end). */
  progress?: number;
  /** Rendered width and height in px. */
  size: number;
  /** Idle motion (bob / breathe / wobble). Off for tiny glyphs. */
  animated?: boolean;
  /** Bumped per tap: replays the squash. 0 = never tapped. */
  squash?: number;
  /** Ids of hearts currently floating up. */
  hearts?: readonly number[];
  /** Accessible name; without one the art is decorative. */
  title?: string;
  className?: string;
}) {
  const shapes = petShapes({ stage, mood, progress });
  const motion = animated ? `zk-pet-motion zk-pet-${petMotion(stage, mood)}` : undefined;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`overflow-visible shrink-0 ${className}`}
      style={petColorStyle(color)}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      <g className={motion}>
        {/* Keyed on the tap count so every tap remounts it and the squash
            animation plays again from the start. */}
        <g key={squash} className={squash > 0 ? 'zk-pet-motion zk-pet-squash' : undefined}>
          {shapes.map(renderShape)}
        </g>
      </g>
      {hearts?.map((id) => (
        <g key={id} className="zk-pet-heart">
          {petHeartShapes().map(renderShape)}
        </g>
      ))}
    </svg>
  );
}
