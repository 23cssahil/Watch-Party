import { Link } from 'react-router-dom';

/**
 * The site footer, shared by the landing page and the legal pages.
 *
 * It carries the copyright, the primary contact, and links to About / Privacy.
 * Kept in one place so the three screens can never drift apart.
 */
export default function SiteFooter() {
  return (
    <footer className="home__footer">
      <p>© {new Date().getFullYear()} Watch Party. All rights reserved.</p>
      <nav className="home__footer-links" aria-label="Footer">
        <Link to="/about">About Us</Link>
        <span aria-hidden>·</span>
        <Link to="/privacy">Privacy Policy</Link>
        <span aria-hidden>·</span>
        <a className="home__footer-mail" href="mailto:23cssahil@gmail.com">
          23cssahil@gmail.com
        </a>
      </nav>
      <p className="home__footer-meta">Made by Sahil.</p>
    </footer>
  );
}
