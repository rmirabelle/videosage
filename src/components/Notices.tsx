import { WarningCircle, X } from "@phosphor-icons/react";

export interface Notice {
  id: number;
  text: string;
}

/** Error messages in the corner of the window. Each one stays until the user closes it. */
export function Notices({ notices, onClose }: { notices: Notice[]; onClose: (id: number) => void }) {
  if (notices.length === 0) return null;
  return (
    <div className="notices" role="alert">
      {notices.map((notice) => (
        <div key={notice.id} className="notice">
          <WarningCircle size={17} weight="fill" />
          <span className="selectable">{notice.text}</span>
          <button onClick={() => onClose(notice.id)} aria-label="Close this message"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
