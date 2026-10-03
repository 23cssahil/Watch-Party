import { useRoomStore } from '../store/roomStore';

/**
 * Transient server messages ("Riya is now moderator", "the host declined your
 * request"). Everything here is a reaction to a WebSocket event, which is why
 * the store owns the queue and this component only renders it.
 */
export default function Toasts() {
  const toasts = useRoomStore((state) => state.toasts);
  const dismiss = useRoomStore((state) => state.dismissToast);

  if (!toasts.length) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast toast--${toast.tone}`}
          onClick={() => dismiss(toast.id)}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
