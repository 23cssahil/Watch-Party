import { useState } from 'react';
import { useRoomStore } from '../store/roomStore';

/**
 * Share card: the two things a host actually sends to a friend — a code to type
 * and a link to tap.
 *
 * `navigator.clipboard` needs a secure context, so the fallback matters: a demo
 * over a plain-http LAN IP would otherwise appear broken on the one machine
 * doing the presenting.
 */
export default function ShareCard() {
  const roomId = useRoomStore((state) => state.roomId);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);

  if (!roomId) return null;

  const link = `${window.location.origin}/room/${roomId}`;

  async function copy(value: string, kind: 'link' | 'code') {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = value;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      document.body.removeChild(helper);
    }
    setCopied(kind);
    setTimeout(() => setCopied(null), 1800);
  }

  return (
    <div className="share">
      <div className="share__header">
        <span className="share__icon" aria-hidden>🔗</span>
        <div>
          <h3 className="share__title">Invite People</h3>
          <p className="share__subtitle">Share the code or link below</p>
        </div>
      </div>

      <button
        type="button"
        className={`share__code ${copied === 'code' ? 'share__code--copied' : ''}`}
        onClick={() => copy(roomId, 'code')}
        title="Click to copy room code"
      >
        <span className="share__code-label">Room Code</span>
        <span className="share__code-value">{roomId}</span>
        <span className="share__code-action">
          {copied === 'code' ? '✓ Copied!' : 'Tap to copy'}
        </span>
      </button>

      <div className="share__divider"><span>or share link</span></div>

      <button
        type="button"
        className={`share__link ${copied === 'link' ? 'share__link--copied' : ''}`}
        onClick={() => copy(link, 'link')}
        title="Click to copy invite link"
      >
        <span className="share__link-icon">{copied === 'link' ? '✓' : '🔗'}</span>
        <span className="share__url">{link}</span>
        <span className="share__link-badge">
          {copied === 'link' ? 'Copied!' : 'Copy'}
        </span>
      </button>

      <p className="share__hint">
        Anyone with this link joins as a <strong>Viewer</strong> — they can watch, chat, and request
        playback changes.
      </p>
    </div>
  );
}
