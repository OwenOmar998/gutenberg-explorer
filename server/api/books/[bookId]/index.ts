import {
  defineEventHandler,
  getCookie,
  type EventHandlerRequest,
  type H3Event,
} from "h3";

import jsdom from "jsdom";
import { getMappedError } from "~/server/app/errors/errorMapper";
import { getUserBySessionToken } from "~/server/app/services/sessionService";
import {
  createBook,
  getBookById,
  updateOrCreateRecentBook,
} from "~/server/database/repositories/bookRepository";
const { JSDOM } = jsdom;
const standardBookError = getMappedError("Not Found", "Book Id Does Not Exist");
export default defineEventHandler(
  async (event: H3Event<EventHandlerRequest>) => {
    const bookId = getRouterParam(event, "bookId");
    if (!bookId) throw new Error("Book ID is required");
    const authToken = getCookie(event, "auth_token");
    const user = await getUserBySessionToken(authToken || "");
    const userId = user?.id;
    if (!userId) throw new Error("User not found");
    const book = await getBookById(bookId);
    if (book) {
      await updateOrCreateRecentBook(bookId, userId);
      return book;
    }
    const contentUrl = `https://www.gutenberg.org/files/${bookId}/${bookId}-0.txt`;
    const metadataUrl = `https://www.gutenberg.org/ebooks/${bookId}`;

    try {
      // Fetch book content
      const [contentResponse, metadataResponse] = await Promise.all([
        fetch(contentUrl),
        fetch(metadataUrl),
      ]);
      const status = metadataResponse.status;
      if (status >= 400) {
        return sendError(
          event,
          createError({ statusCode: 401, data: standardBookError })
        );
      }
      const [content, metadata] = await Promise.all([
        contentResponse.text(),
        metadataResponse.text(),
      ]);
      const dom = new JSDOM(metadata);
      const imageSrc =
        dom.window.document
          .querySelector("img.cover-art")
          ?.getAttribute("src") || undefined;
      const mainContent = dom.window.document.querySelector(
        "#bibrec table.bibrec"
      );
      const rows = mainContent?.querySelectorAll("tr");

      const data: {
        [key: string]: {
          text: string;
          href?: string;
        }[];
      } = {};

      rows?.forEach((row) => {
        const th = row.querySelector("th");
        const td = row.querySelector("td");

        if (th && td) {
          const key = th.textContent?.trim()?.toLowerCase() || "";
          const link = td.querySelector("a");
          if (!data[key]) data[key] = [];
          data[key].push({
            text: link
              ? link.textContent?.trim() || ""
              : td.textContent?.trim() || "",
            href: link
              ? `https://www.gutenberg.org${link.getAttribute("href")}`
              : undefined,
          });
        }
      });
      await createBook({
        id: bookId,
        title: data.title?.[0]?.text || "",
        author: data.author?.[0]?.text || "",
        imageSrc: imageSrc,
        content: content,
        metadata: data,
      });
      await updateOrCreateRecentBook(bookId, userId);

      return {
        id: bookId,
        title: data.title?.[0]?.text || "",
        author: data.author?.[0]?.text || "",
        imageSrc,
        content: content,
        metadata: data,
      };
    } catch (error) {
      return sendError(
        event,
        createError({ statusCode: 401, data: standardBookError })
      );
    }
  }
);