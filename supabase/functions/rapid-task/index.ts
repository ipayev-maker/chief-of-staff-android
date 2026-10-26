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

  // Парсим с опорной датой (сегодня)
  const ref = refDate ? new Date(refDate) : new Date();
  const results = chrono.ru.parse(text, ref);

  const dates = results.map(r => ({
    text: r.text,
    date: r.start.date().toISOString().split('T')[0],
    type: r.start.isCertain('day') ? 'exact' : 'relative'
  }));

  return new Response(JSON.stringify({ dates }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
});
