// Client half of dsh-image-relay.
//
// WHY THIS EXISTS
// The chat UI dispatches a tool call's row through the keyed slot
// "tool.call.toolview", falling back to GenericToolCard for any tool that
// registers no entry. GenericToolCard only knows terminal/diff/read/search/web
// cards and therefore has NO image branch: a relay_image_generate result that
// carries a perfectly valid image block renders as nothing. The only shipped
// tool that renders inline images is read_image (dsh-client-ui-tool's
// imageCardModel hardcodes "call?.name !== 'read_image' -> return null").
//
// So this file registers a keyed toolview for our tool name and renders the
// image itself.
//
// WHY IT RENDERS THE GALLERY DIRECTLY instead of reusing the shipped
// "tool.call.images" child slot: that slot is declared kind:"single" and
// read_image's entry already declares it as a child. The slot contract states
// that registering a second toolview declaring the same child throws at load.
// We therefore take the session-authorized loader straight from our owner props
// (MessageImageLoader, the same one the shipped gallery uses) and render the
// frames ourselves.
//
// This bundle is hand-authored in the pre-built __ModuleLoader__ format that
// dsh-client-modules serves; there is no compile step. It is browser-only.
window.__ModuleLoader__.load({
	id: "dsh-image-relay",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");

		const PLUGIN_ID = "dsh-image-relay";
		const CSS_TAG = PLUGIN_ID + "/RelayImageRow.css";
		const CSS =
			".dshrelay_root{display:flex;flex-direction:column;gap:8px;min-width:0}" +
			".dshrelay_label{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}" +
			".dshrelay_gallery{display:flex;flex-wrap:wrap;gap:10px;max-width:100%}" +
			".dshrelay_frame{border:.5px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-alias-interactive-bg-hover);border-radius:16px;cursor:zoom-in;padding:0;overflow:hidden;display:block;max-width:100%}" +
			".dshrelay_frame img{display:block;max-width:100%;max-height:360px;object-fit:contain}" +
			".dshrelay_loading,.dshrelay_error{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:10px;padding:10px 12px}" +
			".dshrelay_error{background:var(--dsw-alias-interactive-bg-hover-danger);cursor:pointer}" +
			".dshrelay_meta{color:var(--dsw-alias-label-tertiary);font:400 11px/16px var(--ds-font-family-code);white-space:pre-wrap;word-break:break-all;margin:0}";

		if (
			typeof document !== "undefined" &&
			document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = PLUGIN_ID;
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** Narrow an unknown JSON value to a plain record. */
		function asRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
		}

		/** Parse a tool call's raw argument JSON; null when it is absent or malformed. */
		function parsedArguments(raw) {
			if (typeof raw !== "string" || raw === "") return null;
			try {
				return asRecord(JSON.parse(raw));
			} catch {
				return null;
			}
		}

		/** The text blocks of a settled result, joined in order. */
		function resultText(block) {
			const content = Array.isArray(block && block.content) ? block.content : [];
			return content
				.filter((part) => asRecord(part) !== null && part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("\n");
		}

		/** The image blocks of a settled result, in order. */
		function resultImages(block) {
			const content = Array.isArray(block && block.content) ? block.content : [];
			return content
				.filter((part) => asRecord(part) !== null && part.type === "image" && asRecord(part.attachment) !== null)
				.map((part) => part.attachment);
		}

		/**
		 * Recover the workspace path this call wrote, for the "open file" affordance.
		 *
		 * presentationMeta is NOT available here: dsh-tools projects it only for a
		 * root call, and under PTC every sub-dispatch is nested, so block.meta is
		 * always undefined for this tool. We therefore read the path back out of our
		 * own rendered text, falling back to the read_image-style <path> envelope.
		 */
		function savedPathOf(block, text) {
			const meta = asRecord(block && block.meta);
			if (meta !== null && typeof meta.path === "string" && meta.path !== "") return meta.path;
			const marked = /^Saved to: (.+)$/mu.exec(text);
			if (marked !== null) return marked[1].trim();
			const enveloped = /^<path>([^\n]*)<\/path>$/mu.exec(text);
			if (enveloped !== null) return enveloped[1].trim();
			return null;
		}

		/** One durable attachment rendered at a bounded preview size. */
		function RelayImage(props) {
			const attachment = props.attachment;
			const loadImage = props.loadImage;
			const label = props.label;

			const [url, setUrl] = React.useState(() => {
				if (loadImage === undefined || typeof loadImage.peek !== "function") return null;
				return loadImage.peek(attachment) || null;
			});
			const [failed, setFailed] = React.useState(false);
			const [attempt, setAttempt] = React.useState(0);

			React.useEffect(() => {
				if (loadImage === undefined) return undefined;
				let live = true;
				setFailed(false);
				const cached =
					typeof loadImage.peek === "function" ? loadImage.peek(attachment) || null : null;
				if (cached !== null) {
					setUrl(cached);
					return () => {
						live = false;
					};
				}
				Promise.resolve(loadImage(attachment)).then(
					(resolved) => {
						if (live) setUrl(resolved);
					},
					() => {
						if (live) setFailed(true);
					}
				);
				return () => {
					live = false;
				};
			}, [attachment, loadImage, attempt]);

			if (failed) {
				return React.createElement(
					"button",
					{
						type: "button",
						className: "dshrelay_error",
						onClick: () => setAttempt((value) => value + 1)
					},
					"Image failed to load. Click to retry."
				);
			}
			if (url === null) {
				return React.createElement("div", { className: "dshrelay_loading" }, "Loading image…");
			}
			const image = React.createElement("img", {
				src: url,
				alt: label || "Generated image"
			});
			const onOpen = props.onOpen;
			if (onOpen === undefined) {
				return React.createElement("div", { className: "dshrelay_frame" }, image);
			}
			return React.createElement(
				"button",
				{
					type: "button",
					className: "dshrelay_frame",
					title: "Open file",
					onClick: () => onOpen()
				},
				image
			);
		}

		/**
		 * The keyed row for relay_image_generate.
		 *
		 * Always renders the gallery open: the whole point of this entry is that a
		 * generated image must be visible without hunting for a disclosure control.
		 */
		function RelayImageRow(props) {
			const block = props.block;
			const settled = block !== null && typeof block === "object" && block.kind === "tool-result";
			const call = asRecord(block) === null ? null : "kind" in block ? block.call : block;
			const args = parsedArguments(call === null ? undefined : call.argsRaw);
			const text = settled ? resultText(block) : "";
			const images = settled ? resultImages(block) : [];
			const path = settled ? savedPathOf(block, text) : null;

			const heading =
				!settled
					? "Generating image…"
					: block.isError
						? "Image generation failed"
						: images.length > 0
							? "Generated image"
							: "Image generation returned no image";

			const prompt = args !== null && typeof args.prompt === "string" ? args.prompt.trim() : "";

			const children = [
				React.createElement(
					"div",
					{ className: "dshrelay_label", key: "label" },
					prompt === "" ? heading : heading + " — " + prompt
				)
			];

			if (images.length > 0) {
				children.push(
					React.createElement(
						"div",
						{ className: "dshrelay_gallery", key: "gallery" },
						images.map((attachment, index) =>
							React.createElement(RelayImage, {
								key: String(attachment.attachmentId || index),
								attachment,
								loadImage: props.loadImage,
								label: attachment.name,
								onOpen:
									path !== null && typeof props.openFile === "function"
										? () => props.openFile(path)
										: undefined
							})
						)
					)
				);
			}

			if (settled && text !== "") {
				children.push(React.createElement("pre", { className: "dshrelay_meta", key: "meta" }, text));
			}

			return React.createElement("div", { className: "dshrelay_root" }, children);
		}

		// Keyed toolview entry: replaces GenericToolCard for our tool name only.
		// The keyed domain is open (any wire tool name), so no compile-time key set
		// is involved; an unclaimed key falls back to the generic row, which means
		// this registration is purely additive for our own tool.
		exports.inject = ["slots"];
		exports.apply = (ctx) => {
			ctx.slots.inject("tool.call.toolview", () =>
				ctx.slots.register(
					{
						name: "tool.call.toolview",
						key: "relay_image_generate",
						locale: "conversation"
					},
					RelayImageRow
				)
			);
		};
		return module.exports;
	}
});
