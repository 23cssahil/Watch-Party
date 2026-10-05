import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import SiteFooter from '../components/SiteFooter';

// Shared shell for the two static legal/info pages, so they use the same
// background, brand header and footer as the landing page - no separate theme.
function LegalShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="home legal">
      <div className="home__glow" aria-hidden />

      <header className="home__brand">
        <span className="logo-mark" aria-hidden>
          <img src="/favicon.svg" alt="" width="48" height="48" />
        </span>
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </header>

      <section className="legal__body">{children}</section>

      <p className="legal__back">
        <Link to="/">← Back to Watch Party</Link>
      </p>

      <SiteFooter />
    </main>
  );
}

export function About() {
  return (
    <LegalShell title="About Us" subtitle="What Watch Party is and why it exists.">
      <h2>The idea</h2>
      <p>
        Watch Party lets you and your friends watch the same YouTube video together, in real time — no matter
        where everyone is. Press play, pause or seek and the whole room moves with you, to the second.
      </p>

      <h2>How it works</h2>
      <p>
        One person starts a room and becomes the Host; everyone else joins with a six-character code. Playback is
        decided by the server and pushed to every viewer, so nobody drifts out of sync. There is live chat, emoji
        reactions and a queue, all in one shared space.
      </p>

      <h2>Built with</h2>
      <p>
        A React + TypeScript + Vite front end, a Node / Express + Socket.IO realtime server, and MongoDB for
        persistence. No install and no sign-up — open a link and you are in.
      </p>

      <h2>About the project</h2>
      <p>
        Watch Party is an academic B.Tech (Computer Science) project, designed and built by Sahil. For questions,
        feedback or collaboration, reach out at{' '}
        <a className="home__footer-mail" href="mailto:23cssahil@gmail.com">
          23cssahil@gmail.com
        </a>
        .
      </p>
    </LegalShell>
  );
}

export function Privacy() {
  return (
    <LegalShell title="Privacy Policy" subtitle="Short, plain and honest about what we do with data.">
      <p className="legal__updated">Last updated: {new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>

      <h2>No accounts, no passwords</h2>
      <p>
        Watch Party does not require you to register. You only choose a display name so the room knows who is
        talking. We never ask for an email address, phone number or password.
      </p>

      <h2>What a room holds</h2>
      <p>
        While you are in a room we keep the things the party needs to work: your display name, the current video,
        the playback position, the queue and your chat messages. This is shared only with the other people in that
        same room — never with anyone else.
      </p>

      <h2>What we do not do</h2>
      <p>
        We do not sell your data. We do not run advertising networks or third-party behavioural trackers. We do not
        read your microphone or camera. The live-rooms list on the home page only shows a room code, the host's
        display name and how many people are watching — never any private details.
      </p>

      <h2>Deleting your data</h2>
      <p>
        Leave a room and your presence is removed from it. Rooms are cleaned up when they go empty. If you would
        like anything removed sooner, email{' '}
        <a className="home__footer-mail" href="mailto:23cssahil@gmail.com">
          23cssahil@gmail.com
        </a>{' '}
        and it will be handled.
      </p>

      <h2>Videos</h2>
      <p>
        All videos are played through YouTube's own official player. What you watch is governed by YouTube's terms
        and privacy policy, not ours.
      </p>
    </LegalShell>
  );
}
