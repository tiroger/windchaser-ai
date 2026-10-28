import Link from "next/link";
import { Fragment, useMemo } from "react";

import { parseMarkdown, type Inline } from "@/lib/training/ask/markdown";

/**
 * Renders an Ask answer from the markdown-lite tree. Every node becomes a
 * React element or an escaped text node; nothing is ever set as HTML.
 */
function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case "text":
            return <Fragment key={index}>{node.text}</Fragment>;
          case "strong":
            return (
              <strong key={index}>
                <Inlines nodes={node.children} />
              </strong>
            );
          case "em":
            return (
              <em key={index}>
                <Inlines nodes={node.children} />
              </em>
            );
          case "code":
            return <code key={index}>{node.text}</code>;
          case "link":
            return (
              <Link key={index} href={node.href} className="t-link">
                <Inlines nodes={node.children} />
              </Link>
            );
        }
      })}
    </>
  );
}

export default function AskMarkdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="t-ask-md">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "p":
            return (
              <p key={index}>
                <Inlines nodes={block.children} />
              </p>
            );
          case "h":
            return block.level === 3 ? (
              <h3 key={index}>
                <Inlines nodes={block.children} />
              </h3>
            ) : (
              <h4 key={index}>
                <Inlines nodes={block.children} />
              </h4>
            );
          case "ul":
          case "ol": {
            const List = block.type;
            return (
              <List key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <Inlines nodes={item} />
                  </li>
                ))}
              </List>
            );
          }
          case "table":
            return (
              <div key={index} className="t-ask-table">
                <table>
                  <thead>
                    <tr>
                      {block.head.map((cell, cellIndex) => (
                        <th key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? undefined }}>
                          <Inlines nodes={cell} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? undefined }}>
                            <Inlines nodes={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return <hr key={index} />;
        }
      })}
    </div>
  );
}
