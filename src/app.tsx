import type { BonoboClient } from "bonobo-plugin-sdk/frontend";
import { useEffect, useMemo, useRef, useState } from "react";
import { register_mail_tools, type MailView } from "./agent-tools";
import { delete_draft, new_draft_id, save_draft, watch_drafts, type Draft, type DraftFields } from "./drafts";
import { create_mailbox_walk, list_accounts, read_email, type Email, type EmailRow, type MailboxWalk } from "./emails";
import { get_error_message } from "./retry";

/**
 * Rows shown per "Show more". Each shown row reads its file once.
 */
const PAGE_SIZE = 30;

/**
 * The SDK README asks for about 4 calls in flight per route.
 */
const ROW_READ_CONCURRENCY = 4;

/**
 * How much of an email a reply quotes. Even with 3-byte characters this stays under the 15 KB
 * draft limit.
 */
const MAX_QUOTED_CHARS = 3000;

/**
 * Save typed text this long after the member stops typing. The store allows about 30 member
 * writes a minute, so do not save more often.
 */
const AUTOSAVE_DELAY_MS = 2000;

type Selection = { kind: "email"; path: string } | { kind: "draft"; id: string } | null;

function format_date(iso: string) {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function sender_name(from: string) {
	const match = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/u.exec(from);
	return match ? match[1] : from;
}

function addresses_text(addresses: string[]) {
	return addresses.join(", ");
}

function parse_addresses(text: string) {
	return text
		.split(/[,;\n]/u)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function reply_fields(email: Email): DraftFields {
	const subject = /^re:/iu.test(email.headers.subject) ? email.headers.subject : `Re: ${email.headers.subject}`;
	// A draft holds at most 15 KB, so quote only the start of a long email.
	const quotedText = email.body.length > MAX_QUOTED_CHARS ? `${email.body.slice(0, MAX_QUOTED_CHARS)}…` : email.body;
	const quoted = quotedText
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	return {
		to: email.headers.direction === "sent" ? email.headers.to : [email.headers.from],
		cc: [],
		subject,
		body: `\n\nOn ${format_date(email.headers.date)}, ${email.headers.from} wrote:\n${quoted}`,
		replyToPath: email.path,
	};
}

export function App(props: { client: BonoboClient }) {
	const { client } = props;

	const [accounts, setAccounts] = useState<{ path: string; name: string }[] | null>(null);
	const [accountPath, setAccountPath] = useState<string | null>(null);
	const [folder, setFolder] = useState<MailView["folder"]>("all");
	const [rows, setRows] = useState<EmailRow[]>([]);
	const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
	const [walkDone, setWalkDone] = useState(false);
	const [loading, setLoading] = useState(false);
	const [listError, setListError] = useState<string | null>(null);
	const [selection, setSelection] = useState<Selection>(null);
	const [openEmail, setOpenEmail] = useState<Email | null>(null);
	const [readerError, setReaderError] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Draft[] | null>(null);
	const [draftsTruncated, setDraftsTruncated] = useState(false);
	const [draftsError, setDraftsError] = useState<string | null>(null);
	const [composeError, setComposeError] = useState<string | null>(null);

	const walk = useMemo(
		() => (accountPath === null ? null : create_mailbox_walk(client, accountPath)),
		[client, accountPath],
	);
	// The walk that owns the list. A result from an older walk is dropped.
	const walkRef = useRef<MailboxWalk | null>(null);
	// The walk shares one folder stack, so only one fill may run at a time.
	const fillingRef = useRef(false);
	// Row reads: paths waiting, paths already queued, and how many reads run now.
	const rowReadQueueRef = useRef<string[]>([]);
	const rowReadQueuedRef = useRef(new Set<string>());
	const rowReadsActiveRef = useRef(0);
	// The email the member asked for last. A slower read of an older click is dropped.
	const requestedEmailRef = useRef<string | null>(null);

	// The agent tools run outside React. Give them the latest view on every call.
	const viewRef = useRef<MailView>({ accountPath, folder, rows, openEmail, openDraftId: null, drafts: [] });
	viewRef.current = {
		accountPath,
		folder,
		rows,
		openEmail: selection?.kind === "email" ? openEmail : null,
		openDraftId: selection?.kind === "draft" ? selection.id : null,
		drafts: drafts ?? [],
	};

	const show_email = (email: Email) => {
		requestedEmailRef.current = email.path;
		setFolder("all");
		setSelection({ kind: "email", path: email.path });
		setOpenEmail(email);
		setReaderError(null);
	};

	const open_email = (path: string) => {
		requestedEmailRef.current = path;
		setSelection({ kind: "email", path });
		setOpenEmail(null);
		setReaderError(null);
		read_email(client, path).then(
			(email) => {
				if (requestedEmailRef.current === path) {
					setOpenEmail(email);
				}
			},
			(readError: unknown) => {
				if (requestedEmailRef.current === path) {
					setReaderError(get_error_message(readError));
				}
			},
		);
	};

	const open_draft = (id: string) => {
		requestedEmailRef.current = null;
		setFolder("drafts");
		setSelection({ kind: "draft", id });
	};

	// Save a new draft at once, so the editor always edits a stored draft.
	const start_draft = (fields: DraftFields) => {
		const id = new_draft_id();
		setComposeError(null);
		save_draft(client, { id, fields, agentEditedAt: null }).then(
			() => open_draft(id),
			(saveError: unknown) => setComposeError(get_error_message(saveError)),
		);
	};

	/**
	 * Read older folders until the list holds `target` rows or the account has no more mail.
	 */
	const fill_rows = (fromWalk: MailboxWalk, listed: number, target: number) => {
		if (fillingRef.current) {
			return;
		}
		fillingRef.current = true;
		setLoading(true);
		setListError(null);

		const step = async () => {
			let count = listed;
			while (count < target) {
				const next = await fromWalk.next();
				// The member switched accounts. Drop what this walk found.
				if (walkRef.current !== fromWalk) {
					return;
				}
				if (next === null) {
					setWalkDone(true);
					return;
				}
				count += next.length;
				// Append, so row reads that finished meanwhile are kept.
				setRows((current) => [...current, ...next]);
			}
		};
		step()
			.catch((walkError: unknown) => {
				if (walkRef.current === fromWalk) {
					setListError(get_error_message(walkError));
				}
			})
			.finally(() => {
				fillingRef.current = false;
				if (walkRef.current === fromWalk) {
					setLoading(false);
				}
			});
	};

	const load_more = () => {
		if (walk === null || loading) {
			return;
		}

		const target = visibleCount + PAGE_SIZE;
		setVisibleCount(target);
		if (rows.length < target && !walkDone) {
			fill_rows(walk, rows.length, target);
		}
	};

	const pump_row_reads = () => {
		while (rowReadsActiveRef.current < ROW_READ_CONCURRENCY) {
			const path = rowReadQueueRef.current.shift();
			if (path === undefined) {
				return;
			}

			rowReadsActiveRef.current += 1;
			read_email(client, path)
				.then(
					(email) =>
						setRows((current) =>
							current.map((row) => (row.path === path ? { ...row, headers: email.headers } : row)),
						),
					// Keep the row with the subject and day from its path.
					() => {},
				)
				.finally(() => {
					rowReadsActiveRef.current -= 1;
					pump_row_reads();
				});
		}
	};

	// Find the mail accounts once.
	useEffect(() => {
		list_accounts(client).then(
			(found) => {
				setAccounts(found);
				setAccountPath(found[0]?.path ?? null);
			},
			(listAccountsError: unknown) => {
				setAccounts([]);
				setListError(get_error_message(listAccountsError));
			},
		);
	}, [client]);

	// Start the list again when the account changes.
	useEffect(() => {
		setRows([]);
		setVisibleCount(PAGE_SIZE);
		setWalkDone(false);
		setLoading(false);
		rowReadQueueRef.current = [];
		rowReadQueuedRef.current.clear();
		walkRef.current = walk;
		fillingRef.current = false;
		if (walk === null) {
			return;
		}

		fill_rows(walk, 0, PAGE_SIZE);
	}, [walk]);

	// Queue a read for each shown row that was not read yet.
	useEffect(() => {
		for (const row of rows.slice(0, visibleCount)) {
			if (row.headers === null && !rowReadQueuedRef.current.has(row.path)) {
				rowReadQueuedRef.current.add(row.path);
				rowReadQueueRef.current.push(row.path);
			}
		}
		pump_row_reads();
	}, [client, rows, visibleCount]);

	// Watch this member's drafts.
	useEffect(
		() =>
			watch_drafts(client, (result) => {
				if (result === null) {
					setDraftsError("Mail cannot read drafts right now. Reload the page.");
					return;
				}
				setDraftsError(null);
				setDrafts(result.drafts);
				setDraftsTruncated(result.truncated);
			}),
		[client],
	);

	// Register the agent tools for as long as the page is open.
	useEffect(
		() =>
			register_mail_tools(client, {
				getView: () => viewRef.current,
				showEmail: show_email,
				showDraft: open_draft,
			}),
		[client],
	);

	const selectedDraft =
		selection?.kind === "draft" ? (drafts ?? []).find((draft) => draft.id === selection.id) ?? null : null;

	return (
		<div className="mail">
			<nav className="mail-rail" aria-label="Mailboxes">
				<button
					className="button is-primary"
					onClick={() => start_draft({ to: [], cc: [], subject: "", body: "", replyToPath: null })}
				>
					Compose
				</button>
				{composeError !== null ? (
					<p className="mail-status is-error" role="alert">
						{composeError}
					</p>
				) : null}
				<button
					className="mail-rail-item"
					aria-current={folder === "all" ? "page" : undefined}
					onClick={() => setFolder("all")}
				>
					All mail
				</button>
				<button
					className="mail-rail-item"
					aria-current={folder === "drafts" ? "page" : undefined}
					onClick={() => setFolder("drafts")}
				>
					Drafts
					{drafts !== null && drafts.length > 0 ? <span className="mail-rail-count">{drafts.length}</span> : null}
				</button>
				{accounts !== null && accounts.length > 1 ? (
					<label className="mail-rail-account">
						Account
						<select value={accountPath ?? ""} onChange={(event) => setAccountPath(event.currentTarget.value)}>
							{accounts.map((account) => (
								<option key={account.path} value={account.path}>
									{account.name}
								</option>
							))}
						</select>
					</label>
				) : null}
			</nav>

			<section className="mail-list" aria-label={folder === "all" ? "All mail" : "Drafts"}>
				{folder === "all" ? (
					<>
						{accounts !== null && accounts.length === 0 && listError === null ? (
							<p className="mail-status">
								No emails yet. Install the Gmail plugin and sync your inbox to <code>/emails</code>.
							</p>
						) : null}
						<ul className="mail-rows">
							{rows.slice(0, visibleCount).map((row) => (
								<li key={row.path}>
									<button
										className="mail-row"
										aria-current={selection?.kind === "email" && selection.path === row.path ? "true" : undefined}
										data-direction={row.headers?.direction ?? undefined}
										onClick={() => open_email(row.path)}
									>
										<span className="mail-row-from">
											{row.headers === null
												? ""
												: row.headers.direction === "sent"
													? `To: ${sender_name(row.headers.to[0] ?? "")}`
													: sender_name(row.headers.from)}
										</span>
										<span className="mail-row-date">{row.headers ? format_date(row.headers.date) : row.day}</span>
										<span className="mail-row-subject">{row.headers?.subject ?? row.subject}</span>
									</button>
								</li>
							))}
						</ul>
						{loading ? (
							<p className="mail-status" role="status">
								Loading…
							</p>
						) : null}
						{!loading && walk !== null && (rows.length > visibleCount || !walkDone) ? (
							<button className="button mail-more" onClick={load_more}>
								Show more
							</button>
						) : null}
						{listError !== null ? (
							<p className="mail-status is-error" role="alert">
								{listError}
							</p>
						) : null}
					</>
				) : (
					<>
						{draftsError !== null ? (
							<p className="mail-status is-error" role="alert">
								{draftsError}
							</p>
						) : null}
						{drafts !== null && drafts.length === 0 ? <p className="mail-status">No drafts. Ask the agent to write one.</p> : null}
						<ul className="mail-rows">
							{(drafts ?? []).map((draft) => (
								<li key={draft.id}>
									<button
										className="mail-row"
										aria-current={selection?.kind === "draft" && selection.id === draft.id ? "true" : undefined}
										onClick={() => open_draft(draft.id)}
									>
										<span className="mail-row-from">
											{draft.to.length > 0 ? `To: ${addresses_text(draft.to)}` : "No recipients"}
										</span>
										<span className="mail-row-date">
											{draft.agentEditedAt !== null ? <span className="mail-badge">Agent</span> : null}
										</span>
										<span className="mail-row-subject">{draft.subject || "(no subject)"}</span>
									</button>
								</li>
							))}
						</ul>
						{draftsTruncated ? <p className="mail-status">Showing the 100 newest drafts.</p> : null}
					</>
				)}
			</section>

			<main className="mail-reader">
				{selection === null ? <p className="mail-status">Choose an email or a draft.</p> : null}
				{selection?.kind === "email" ? (
					readerError !== null ? (
						<p className="mail-status is-error" role="alert">
							{readerError}
						</p>
					) : openEmail === null || openEmail.path !== selection.path ? (
						<p className="mail-status" role="status">
							Opening…
						</p>
					) : (
						<EmailReader email={openEmail} onReply={() => start_draft(reply_fields(openEmail))} />
					)
				) : null}
				{selection?.kind === "draft" ? (
					selectedDraft !== null ? (
						<DraftEditor
							// Reload the editor only when the agent saved the draft, so an agent edit shows at
							// once. The member's own saves keep the editor and what they typed.
							key={`${selectedDraft.id}:${selectedDraft.agentEditedAt ?? 0}`}
							client={client}
							draft={selectedDraft}
							onDeleted={() => setSelection(null)}
						/>
					) : (
						<p className="mail-status" role="status">
							{/* The draft list is loaded, so a missing draft was deleted or is past the first 100. */}
							{drafts === null ? "Opening the draft…" : "This draft is not available. It may have been deleted."}
						</p>
					)
				) : null}
			</main>
		</div>
	);
}

function EmailReader(props: { email: Email; onReply: () => void }) {
	const { email, onReply } = props;

	return (
		<article className="mail-email" aria-label={email.headers.subject}>
			<header className="mail-email-header">
				<h1>{email.headers.subject}</h1>
				<dl>
					<dt>From</dt>
					<dd>{email.headers.from}</dd>
					<dt>To</dt>
					<dd>{addresses_text(email.headers.to)}</dd>
					{email.headers.cc.length > 0 ? (
						<>
							<dt>Cc</dt>
							<dd>{addresses_text(email.headers.cc)}</dd>
						</>
					) : null}
					<dt>Date</dt>
					<dd>{format_date(email.headers.date)}</dd>
				</dl>
				<div className="mail-actions">
					<button className="button" onClick={onReply}>
						Reply
					</button>
				</div>
			</header>
			<div className="mail-email-body">{email.body}</div>
		</article>
	);
}

function DraftEditor(props: { client: BonoboClient; draft: Draft; onDeleted: () => void }) {
	const { client, draft, onDeleted } = props;

	const [to, setTo] = useState(addresses_text(draft.to));
	const [cc, setCc] = useState(addresses_text(draft.cc));
	const [subject, setSubject] = useState(draft.subject);
	const [body, setBody] = useState(draft.body);
	const [edited, setEdited] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<{ text: string; isError: boolean } | null>(null);

	const run = (action: () => Promise<void>, doneText: string) => {
		setBusy(true);
		setStatus(null);
		action().then(
			() => {
				setBusy(false);
				setStatus({ text: doneText, isError: false });
			},
			(actionError: unknown) => {
				setBusy(false);
				setStatus({ text: get_error_message(actionError), isError: true });
			},
		);
	};

	const fields = (): DraftFields => ({
		to: parse_addresses(to),
		cc: parse_addresses(cc),
		subject,
		body,
		replyToPath: draft.replyToPath,
	});

	// Keep `agentEditedAt`, so the member's save does not reload the editor or drop the badge.
	const handle_save = () => {
		setEdited(false);
		run(() => save_draft(client, { id: draft.id, fields: fields(), agentEditedAt: draft.agentEditedAt }), "Saved");
	};

	const handle_copy = () =>
		run(async () => {
			const current = fields();
			const text = [
				`To: ${addresses_text(current.to)}`,
				...(current.cc.length > 0 ? [`Cc: ${addresses_text(current.cc)}`] : []),
				`Subject: ${current.subject}`,
				"",
				current.body,
			].join("\n");
			await navigator.clipboard.writeText(text);
		}, "Copied. Paste it into Gmail to send it.");

	// Stop a pending autosave first, or it could store the draft again after the delete.
	const handle_delete = () => {
		setEdited(false);
		run(async () => {
			await delete_draft(client, draft.id);
			onDeleted();
		}, "Deleted");
	};

	// Save typed text a moment after the member stops typing, like Gmail does. Then switching to
	// another email or draft loses at most the last two seconds. Leaving the editor clears the timer,
	// so a late save never writes over an agent edit that reloaded the editor.
	useEffect(() => {
		if (!edited) {
			return;
		}

		const timer = setTimeout(() => {
			save_draft(client, { id: draft.id, fields: fields(), agentEditedAt: draft.agentEditedAt }).then(
				() => setStatus({ text: "Saved", isError: false }),
				(saveError: unknown) => setStatus({ text: get_error_message(saveError), isError: true }),
			);
		}, AUTOSAVE_DELAY_MS);
		return () => clearTimeout(timer);
	}, [edited, to, cc, subject, body]);

	return (
		<form
			className="mail-draft"
			aria-label="Draft"
			onSubmit={(event) => {
				event.preventDefault();
				handle_save();
			}}
		>
			<header className="mail-draft-header">
				<h1>Draft</h1>
				{draft.agentEditedAt !== null ? <span className="mail-badge">Edited by the agent</span> : null}
			</header>
			<label className="mail-field">
				<span>To</span>
				<input value={to} onInput={(event) => {
						setTo(event.currentTarget.value);
						setEdited(true);
					}} autoComplete="off" />
			</label>
			<label className="mail-field">
				<span>Cc</span>
				<input value={cc} onInput={(event) => {
						setCc(event.currentTarget.value);
						setEdited(true);
					}} autoComplete="off" />
			</label>
			<label className="mail-field">
				<span>Subject</span>
				<input value={subject} onInput={(event) => {
						setSubject(event.currentTarget.value);
						setEdited(true);
					}} />
			</label>
			<label className="mail-field is-body">
				<span>Body</span>
				<textarea value={body} onInput={(event) => {
						setBody(event.currentTarget.value);
						setEdited(true);
					}} />
			</label>
			<div className="mail-actions">
				<button className="button is-primary" type="submit" disabled={busy}>
					Save
				</button>
				<button className="button" type="button" disabled={busy} onClick={handle_copy}>
					Copy
				</button>
				<button className="button" type="button" disabled={busy} onClick={handle_delete}>
					Delete
				</button>
				{status !== null ? (
					<span className={status.isError ? "mail-draft-status is-error" : "mail-draft-status"} role="status">
						{status.text}
					</span>
				) : null}
			</div>
			<p className="mail-note">
				Mail does not send email. Copy the draft into Gmail to send it. When the agent changes this draft, its
				version replaces text you did not save.
			</p>
		</form>
	);
}
