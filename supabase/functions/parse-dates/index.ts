import {serveProtected} from '../_shared/legacy-auth.ts';
import * as chrono from "npm:chrono-node@2.7.5";

serveProtected(async (req) => {
  const { text, refDate } = await req.json();

  if (!text) {
    return new Response(JSON.stringify({ dates: [] }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }

  const ref = refDate ? new Date(refDate) : new Date();
  const results = chrono.ru.parse(text, ref);

  const dates = results.map((r) => {
    let d = r.start.date();

    // Если в тексте НЕТ явной даты "число месяц" и дата получилась в прошлом —
    // значит это день недели ("до пятницы") → переносим на следующую неделю
    const hasExplicitDate = /\d{1,2}\s*(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/i.test(r.text);

    if (!hasExplicitDate && d.getTime() < ref.getTime()) {
      d = new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000);
    }

    return {
      text: r.text,
      date: d.toISOString().split("T")[0],
    };
  });

  return new Response(JSON.stringify({ dates }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
});
