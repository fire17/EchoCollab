/**
 * Editor surface + remote-caret styling.
 *
 * The caret colour itself comes from each peer's awareness state at runtime;
 * everything here is the shape those carets take.
 */
import { EditorView } from '@codemirror/view';

export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '15px',
    backgroundColor: 'transparent',
    color: 'var(--ink)',
  },
  // Centred on the scroller, not on the content: centring the content alone
  // would leave the gutter stranded against the left edge.
  '.cm-scroller': {
    fontFamily: 'var(--mono)',
    lineHeight: '1.7',
    padding: '22px 24px 40vh',
    maxWidth: '96ch',
    margin: '0 auto',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 8px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--ink-faint)',
    border: 'none',
    paddingRight: '6px',
  },
  '.cm-activeLine': { backgroundColor: 'var(--line-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-dim)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--select)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-placeholder': { color: 'var(--ink-faint)', fontStyle: 'italic' },
  '.cm-selectionMatch': { backgroundColor: 'var(--match)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--ink)', border: 'none' },
  '.cm-panels input, .cm-panels button': {
    background: 'var(--panel-2)', color: 'var(--ink)',
    border: '1px solid var(--edge)', borderRadius: '6px', padding: '3px 7px',
  },
  '.cm-tooltip': {
    background: 'var(--panel)', border: '1px solid var(--edge)',
    borderRadius: '10px', overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--accent)', color: '#08111c' },

  // --- remote peers -------------------------------------------------------
  '.cm-ySelectionCaret': {
    position: 'relative',
    borderLeft: '2px solid',
    borderRight: 'none',
    marginLeft: '-1px',
    marginRight: '-1px',
    boxSizing: 'border-box',
  },
  '.cm-ySelectionCaretDot': { display: 'none' },
  '.cm-ySelectionInfo': {
    position: 'absolute',
    top: '-1.5em',
    left: '-2px',
    fontSize: '11px',
    fontFamily: 'var(--sans)',
    fontWeight: '600',
    lineHeight: '1.5',
    letterSpacing: '.01em',
    padding: '1px 6px',
    borderRadius: '5px 5px 5px 1px',
    color: '#08111c',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    pointerEvents: 'none',
    zIndex: '12',
    // The label sits above its line, so a stack of peers on consecutive lines
    // would bury the text. y-codemirror rebuilds the caret whenever its peer
    // moves, which restarts this animation: the name appears as they move and
    // fades out once they settle. Hovering the line brings it back.
    animation: 'echo-label 2.4s ease-out forwards',
  },
  '@keyframes echo-label': {
    '0%, 45%': { opacity: '1' },
    '100%': { opacity: '0' },
  },
  '.cm-line:hover .cm-ySelectionInfo, .cm-ySelectionCaret:hover > .cm-ySelectionInfo': {
    animation: 'none',
    opacity: '1',
  },
});
