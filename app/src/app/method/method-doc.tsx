import type { ComponentProps, ElementType } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { FALLBACK_METHOD_MARKDOWN, prepareMethodMarkdown, resolveDocHref } from "@/lib/method/doc";

// No typography plugin is installed, so style the markdown elements here.
type Tag = "h1" | "h2" | "h3" | "p" | "ul" | "ol" | "li" | "code" | "blockquote" | "th" | "td";

// react-markdown passes its hast `node`; drop it so it does not reach the DOM.
function styled<T extends Tag>(Tag: T, className: string) {
  function Styled(props: ComponentProps<T> & ExtraProps) {
    const { node, className: extra, ...rest } = props as ComponentProps<Tag> & ExtraProps;
    void node;
    const El = Tag as ElementType;
    return <El className={cn(className, extra)} {...rest} />;
  }
  return Styled;
}

const components: Components = {
  h1: styled("h1", "text-2xl font-semibold tracking-tight"),
  h2: styled("h2", "mt-8 mb-2 text-xl font-semibold"),
  h3: styled("h3", "mt-6 mb-2 text-lg font-semibold"),
  p: styled("p", "my-3 leading-7"),
  ul: styled("ul", "my-3 list-disc space-y-1 pl-6"),
  ol: styled("ol", "my-3 list-decimal space-y-1 pl-6"),
  li: styled("li", "leading-7"),
  code: styled("code", "rounded bg-muted px-1 py-0.5 font-mono text-sm"),
  blockquote: styled("blockquote", "my-3 border-l-2 pl-4 text-muted-foreground"),
  th: styled("th", "border-b px-2 py-1.5 text-left font-medium"),
  td: styled("td", "border-b px-2 py-1.5 align-top"),
  a: function Link({ node, href, ...rest }) {
    void node;
    return <a className="underline underline-offset-2 break-words" href={resolveDocHref(href)} {...rest} />;
  },
  table: function Table({ node, ...rest }) {
    void node;
    return (
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-sm" {...rest} />
      </div>
    );
  },
};

export function MarkdownDoc({ markdown }: { markdown: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {prepareMethodMarkdown(markdown)}
    </Markdown>
  );
}

/** METHOD.md if present, else a short summary and a pending note. */
export function MethodDoc({ markdown }: { markdown: string | null }) {
  if (markdown) return <MarkdownDoc markdown={markdown} />;
  return (
    <>
      <MarkdownDoc markdown={FALLBACK_METHOD_MARKDOWN} />
      <p className="mt-4 rounded-md border px-3 py-2 text-sm text-muted-foreground" role="note">
        This is a short summary. The full method write-up is pending.
      </p>
    </>
  );
}
