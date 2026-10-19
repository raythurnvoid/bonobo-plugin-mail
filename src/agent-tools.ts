import type { BonoboClient } from "bonobo-plugin-sdk/frontend";
import { delete_draft, new_draft_id, save_draft, validate_draft_fields, type Draft, type DraftFields } from "./drafts";
import { read_email, type Email, type EmailRow } from "./emails";

/**
 * The host drops a tool answer over 32 KiB. These byte limits keep every answer below it: one long
 * text, a few short previews, and capped address lists.
 */
const MAX_TEXT_BYTES = 12_000;
const MAX_PREVIEW_BYTES = 300;
const MAX_LISTED_ADDRESSES = 10;
const MAX_VIEW_ROWS = 25;
const MAX_LISTED_DRAFTS = 25;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * What the page shows right now. The tools read it on each call, so they always see the latest view.
 */
export type MailView = {
	accountPath: string | null;
	folder: "all" | "drafts";
	rows: EmailRow[];
	openEmail: Email | null;
	openDraftId: string | null;
	drafts: Draft[];
};

/**
 * What a tool may change in the page.
 */
export type MailViewControls = {
	getView: () => MailView;
	showEmail: (email: Email) => void;
	showDraft: (id: string) => void;
};

/**
 * Cut text to at most `maxBytes` UTF-8 bytes. A character cut in half becomes U+FFFD.
 */
function cut(text: string, maxBytes: number) {
	const bytes = TEXT_ENCODER.encode(text);
	return bytes.byteLength <= maxBytes
		? text
		: `${TEXT_DECODER.decode(bytes.slice(0, maxBytes))}\n[Shortened. Open the file for the rest.]`;
}

function addresses(list: string[]) {
	return list.slice(0, MAX_LISTED_ADDRESSES).map((address) => cut(address, MAX_PREVIEW_BYTES));
}

function describe_email(email: Email) {
	return {
		path: email.path,
		from: cut(email.headers.from, MAX_PREVIEW_BYTES),
		to: addresses(email.headers.to),
		cc: addresses(email.headers.cc),
		subject: cut(email.headers.subject, MAX_PREVIEW_BYTES),
		date: email.headers.date,
		direction: email.headers.direction,
		body: cut(email.body, MAX_TEXT_BYTES),
	};
}

function describe_draft(draft: Draft, bodyBytes: number) {
	return {
		draftId: draft.id,
		to: addresses(draft.to),
		cc: addresses(draft.cc),
		subject: cut(draft.subject, MAX_PREVIEW_BYTES),
		body: cut(draft.body, bodyBytes),
		replyToPath: draft.replyToPath,
		editedByAgent: draft.agentEditedAt !== null,
	};
}

// The model writes tool input, so check every field before use, even with the manifest schema.
function read_object(input: unknown) {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("The input must be an object");
	}
	return input as Record<string, unknown>;
}

function read_string(input: Record<string, unknown>, key: string) {
	const value = input[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${key} must be a string`);
	}
	return value;
}

function read_strings(input: Record<string, unknown>, key: string) {
	const value = input[key];
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${key} must be a list of strings`);
	}
	return value as string[];
}

function require_value<T>(value: T | undefined, key: string) {
	if (value === undefined) {
		throw new Error(`${key} is required`);
	}
	return value;
}

/**
 * Register the page's agent tools. The names and input schemas match `agent.tools` in
 * bonobo.plugin.json. Returns one function that removes them all.
 */
export function register_mail_tools(client: BonoboClient, controls: MailViewControls) {
	const find_draft = (id: string) => {
		const draft = controls.getView().drafts.find((candidate) => candidate.id === id);
		if (!draft) {
			throw new Error(`No draft has the id ${id}. Call list_drafts to see the ids.`);
		}
		return draft;
	};

	const unregister = [
		client.agent.registerTool("get_view", () => {
			const view = controls.getView();
			const openDraft = view.drafts.find((draft) => draft.id === view.openDraftId);
			return {
				account: view.accountPath,
				folder: view.folder,
				openEmail: view.openEmail ? describe_email(view.openEmail) : null,
				openDraft: openDraft ? describe_draft(openDraft, MAX_TEXT_BYTES) : null,
				emails: view.rows.slice(0, MAX_VIEW_ROWS).map((row) => ({
					path: row.path,
					from: row.headers ? cut(row.headers.from, MAX_PREVIEW_BYTES) : null,
					subject: cut(row.headers?.subject ?? row.subject, MAX_PREVIEW_BYTES),
					date: row.headers?.date ?? row.day,
					direction: row.headers?.direction ?? null,
				})),
				draftCount: view.drafts.length,
			};
		}),

		client.agent.registerTool("open_email", async (input) => {
			const path = require_value(read_string(read_object(input), "path"), "path");
			if (!path.startsWith("/") || !path.endsWith(".md")) {
				throw new Error("path must be a Files path that ends with .md");
			}

			const email = await read_email(client, path);
			controls.showEmail(email);
			return describe_email(email);
		}),

		client.agent.registerTool("list_drafts", () => {
			const drafts = controls.getView().drafts;
			return {
				drafts: drafts.slice(0, MAX_LISTED_DRAFTS).map((draft) => describe_draft(draft, MAX_PREVIEW_BYTES)),
				total: drafts.length,
				note: "Bodies are previews. get_view shows the full body of the open draft.",
			};
		}),

		client.agent.registerTool("create_draft", async (input) => {
			const object = read_object(input);
			const fields: DraftFields = {
				to: require_value(read_strings(object, "to"), "to"),
				cc: read_strings(object, "cc") ?? [],
				subject: require_value(read_string(object, "subject"), "subject"),
				body: require_value(read_string(object, "body"), "body"),
				replyToPath: read_string(object, "replyToPath") ?? null,
			};
			validate_draft_fields(fields);

			const id = new_draft_id();
			await save_draft(client, { id, fields, agentEditedAt: Date.now() });
			controls.showDraft(id);
			return { draftId: id, saved: true, note: "The draft is open in the Mail page. It was not sent." };
		}),

		client.agent.registerTool("update_draft", async (input) => {
			const object = read_object(input);
			const draft = find_draft(require_value(read_string(object, "draftId"), "draftId"));
			const fields: DraftFields = {
				to: read_strings(object, "to") ?? draft.to,
				cc: read_strings(object, "cc") ?? draft.cc,
				subject: read_string(object, "subject") ?? draft.subject,
				body: read_string(object, "body") ?? draft.body,
				replyToPath: draft.replyToPath,
			};

			await save_draft(client, { id: draft.id, fields, agentEditedAt: Date.now() });
			controls.showDraft(draft.id);
			return { draftId: draft.id, saved: true };
		}),

		client.agent.registerTool("delete_draft", async (input) => {
			const draft = find_draft(require_value(read_string(read_object(input), "draftId"), "draftId"));
			await delete_draft(client, draft.id);
			return { draftId: draft.id, deleted: true };
		}),
	];

	return () => {
		for (const remove of unregister) {
			remove();
		}
	};
}
