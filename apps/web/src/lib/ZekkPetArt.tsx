/**
 * ZekkPetArt
 * ----------
 * The Zekk Pet as an inline SVG, drawn from lib/petArt's primitives (the same
 * geometry the iOS and Android apps draw). Colours are the viewer's theme
 * (--zk-pet-* in index.css), so the pet recolours live on a theme switch.
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
import { petHeartShapes, petMotion, petShapes, type PetShape } from './petArt';

function renderShape(s: PetShape, key: number) {
  const { fill, stroke, ...rest } = s.attrs;
  const style: CSSProperties = {};
  if (fill !== undefined) style.fill = String(fill);
  if (stroke !== undefined) style.stroke = String(stroke);
  return createElement(s.tag, { key, ...rest, style });
}

export function ZekkPetArt({
  stage,
  mood,
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
