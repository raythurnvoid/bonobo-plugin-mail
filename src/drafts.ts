import type { BonoboClient } from "bonobo-plugin-sdk/frontend";

/**
 * Drafts live in the plugin store, in the `drafts` collection. Mail does not write to Gmail: that
 * would need a Gmail sign-in with the compose scope, which this plugin does not ask for.
 */
const DRAFTS_COLLECTION = "drafts";

/**
 * The store door reads at most 100 documents per watch.
 */
const DRAFTS_WATCH_LIMIT = 100;

const MAX_ADDRESSES = 50;
const MAX_SUBJECT_LENGTH = 500;
/**
 * The store keeps at most 16 KiB of JSON per document. Keep some room for the id and the times.
 */
const MAX_DRAFT_BYTES = 15 * 1024;

export type Draft = {
	/**
	 * The id the member and the agent use. The stored key is `<userId>-<id>:<userId>`.
	 */
	id: string;
	to: string[];
	cc: string[];
	subject: string;
	body: string;
	replyToPath: string | null;
	/**
	 * When the agent last saved the draft, or null when it never did. The page shows an "Agent" badge
	 * and reloads the open editor when this changes.
	 */
	agentEditedAt: number | null;
	updatedAt: number;
};

export type DraftFields = Pick<Draft, "to" | "cc" | "subject" | "body" | "replyToPath">;

export type DraftsWatchResult = { drafts: Draft[]; truncated: boolean } | null;

/**
 * The caller part of an owned key. The server appends `:<userId>` to it.
 *
 * The member's id comes first too, so a key prefix can watch only this member's drafts through the
 * store index. Another member could still write a key with this prefix, so the watch also checks
 * `createdBy`.
 */
function owned_key(userId: string, id: string) {
	return `${userId}-${id}`;
}

/**
 * A new draft id. The time part counts down, so the store's ascending key order is newest first and
 * the watch window keeps the newest drafts.
 */
export function new_draft_id() {
	const countdown = (Number.MAX_SAFE_INTEGER - Date.now()).toString(36).padStart(11, "0");
	return `d${countdown}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Check draft fields that came from the agent or the editor. Throw a plain message, because a page
 * tool sends a thrown message back to the agent.
 */
export function validate_draft_fields(fields: DraftFields) {
	if (fields.to.length + fields.cc.length > MAX_ADDRESSES) {
		throw new Error(`A draft can have at most ${MAX_ADDRESSES} recipients`);
	}
	if (fields.subject.length > MAX_SUBJECT_LENGTH) {
		throw new Error(`A subject can have at most ${MAX_SUBJECT_LENGTH} characters`);
	}
	if (new TextEncoder().encode(JSON.stringify(fields)).byteLength > MAX_DRAFT_BYTES) {
		throw new Error("A draft can have at most 15 KB of text. Shorten the body.");
	}
}

function parse_draft(value: Record<string, unknown>, updatedAt: number): Draft | null {
	const id = value.id;
	if (typeof id !== "string") {
		return null;
	}

	const strings = (raw: unknown) =>
		Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
	return {
		id,
		to: strings(value.to),
		cc: strings(value.cc),
		subject: typeof value.subject === "string" ? value.subject : "",
		body: typeof value.body === "string" ? value.body : "",
		replyToPath: typeof value.replyToPath === "string" ? value.replyToPath : null,
		agentEditedAt: typeof value.agentEditedAt === "number" ? value.agentEditedAt : null,
		updatedAt,
	};
}

/**
 * Watch this member's newest drafts. `onChange` gets `null` when the store refused or failed the
 * read.
 */
export function watch_drafts(client: BonoboClient, onChange: (result: DraftsWatchResult) => void) {
	const userId = client.context.userId;
	const watch = client.convex.watchQuery(client.api.plugins_data.watch_documents, {
		collection: DRAFTS_COLLECTION,
		keyPrefix: `${userId}-`,
		limit: DRAFTS_WATCH_LIMIT,
	});

	const deliver = () => {
		let result;
		try {
			result = watch.localQueryResult();
		} catch {
			// A failed query throws here. Treat it like a refusal.
			onChange(null);
			return;
		}
		if (result === undefined) {
			return;
		}
		if (result === null) {
			onChange(null);
			return;
		}

		const drafts = result.docs
			.filter((doc) => doc.createdBy === userId)
			.map((doc) => parse_draft(doc.value, doc.updatedAt))
			.filter((draft): draft is Draft => draft !== null);
		onChange({ drafts, truncated: result.truncated });
	};

	deliver();
	return watch.onUpdate(deliver);
}

export async function save_draft(
	client: BonoboClient,
	args: { id: string; fields: DraftFields; agentEditedAt: number | null },
) {
	validate_draft_fields(args.fields);

	const result = await client.convex.mutation(client.api.plugins_data.user_put_owned_document, {
		collection: DRAFTS_COLLECTION,
		key: owned_key(client.context.userId, args.id),
		value: { id: args.id, ...args.fields, agentEditedAt: args.agentEditedAt },
	});
	if (result._nay) {
		throw new Error(`Failed to save the draft: ${result._nay.message}`);
	}
}

export async function delete_draft(client: BonoboClient, id: string) {
	const result = await client.convex.mutation(client.api.plugins_data.user_remove_owned_document, {
		collection: DRAFTS_COLLECTION,
		key: owned_key(client.context.userId, id),
	});
	if (result._nay) {
		throw new Error(`Failed to delete the draft: ${result._nay.message}`);
	}
	if (!result._yay.deleted) {
		throw new Error(`No draft has the id ${id}`);
	}
}
