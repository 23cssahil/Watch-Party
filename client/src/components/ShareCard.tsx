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
      <h3 className="panel__title">Invite people</h3>

      <button type="button" className="share__code" onClick={() => copy(roomId, 'code')}>
        <span>{roomId}</span>
        <em>{copied === 'code' ? 'Copied' : 'Copy code'}</em>
      </button>

      <button type="button" className="share__link" onClick={() => copy(link, 'link')}>
        <span className="share__url">{link}</span>
        <em>{copied === 'link' ? 'Copied' : 'Copy link'}</em>
      </button>

      <p className="share__hint">
        Anyone who opens this link joins as a viewer — they can watch and chat, and can ask you to
        change what is playing.
      </p>
    </div>
  );
}
