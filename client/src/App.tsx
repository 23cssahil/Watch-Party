import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useSocket } from './hooks/useSocket';
import Home from './pages/Home';
import Room from './pages/Room';
import Toasts from './components/Toasts';

/**
 * Route shell.
 *
 * `useSocket()` is called exactly once, here, so the socket listeners live for
 * the whole session rather than being attached per page. Mounting it at the top
 * also means a hard refresh on /room/ABC123 re-establishes the room straight
 * from the URL, without Home ever having to render.
 */
export default function App() {
  useSocket();

  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/room/:code" element={<Room />} />
        {/* Short form, for links pasted into chat: /r/ABC123 */}
        <Route path="/r/:code" element={<ShortLinkRedirect />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </>
  );
}

function ShortLinkRedirect() {
  const { code } = useParams<{ code: string }>();
  return <Navigate to={`/room/${code?.toUpperCase() ?? ''}`} replace />;
}
