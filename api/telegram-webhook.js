const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://wdtcygterxwqqashtqkr.supabase.co';

function db(){
  return createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function sendTelegram(text){
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: '\u2197 Open dashboard', url: 'https://command-centre-liard.vercel.app' }]] } })
  });
}

function helsinkiNowISO(){
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Helsinki' }).replace(' ', 'T');
}

async function gatherContext(supa, userId){
  const [{ data: todos }, { data: projects }, { data: habits }, { data: mantraRow }, { data: sleep }] = await Promise.all([
    supa.from('todos').select('text,pri,done,due_at,completed_at').eq('user_id', userId),
    supa.from('projects').select('name,pct,due,tags,done,archived').eq('user_id', userId).eq('archived', false),
    supa.from('habits').select('name,cat,streak,pb,status,history').eq('user_id', userId),
    supa.from('mantras').select('content').eq('user_id', userId).maybeSingle(),
    supa.from('sleep_logs').select('log_date,score,note').eq('user_id', userId).order('log_date', {ascending:false}).limit(21)
  ]);
  // Trim habit history to last 14 days to keep context small
  const trimmedHabits = (habits||[]).map(h => {
    let hist = h.history || {};
    if(Array.isArray(hist)){ const m={}; hist.forEach(d=>m[d]='done'); hist=m; }
    const dates = Object.keys(hist).sort().slice(-14);
    const recent = {};
    dates.forEach(d => recent[d] = hist[d]);
    return { name:h.name, cat:h.cat, streak:h.streak, pb:h.pb, today:h.status, last14days:recent };
  });
  return {
    now_helsinki: helsinkiNowISO(),
    todos: todos||[],
    projects: projects||[],
    habits: trimmedHabits,
    mantras: (mantraRow && mantraRow.content) ? mantraRow.content.split('\n').filter(Boolean) : [],
    sleep_last_21_days: sleep||[]
  };
}

const SYSTEM_PROMPT = `You are the assistant inside "Command Centre", Sami's personal life dashboard. You receive his Telegram messages and must respond with ONLY a JSON object (no markdown, no backticks, no prose outside the JSON).

The JSON must have this shape:
{
  "actions": [ ... zero or more action objects ... ],
  "reply": "the message to send back to Sami in Telegram"
}

Supported action objects:
1. Create a to-do: {"type":"create_todo","text":"...","pri":"high"|"med"|"low","due_at":"ISO datetime in UTC or null"}
2. Complete a to-do: {"type":"complete_todo","match":"text to find the todo by"}
3. Delete a to-do: {"type":"delete_todo","match":"text to find the todo by"}

Rules:
- Times Sami mentions are Helsinki time (UTC+3 in summer). Convert to UTC for due_at. "in 2 hours" = current time + 2h.
- If he asks to be reminded, set due_at accordingly; the reminder system pings at set checkpoints before the due time automatically (24h,12h,10h,8h,6h,4h,2h before and at expiry).
- If due_at is within 2 hours, he will get the expiry-time reminder; mention when he'll be pinged in your reply.
- Default priority "med" unless he signals urgency.
- If he's asking a question (not requesting an action), use an empty actions array and answer from the context data.
- Be concise, warm, and direct in replies. Plain text only (no markdown). Use Helsinki local times when mentioning times to him.
- If the request is ambiguous, don't guess wildly: do the most reasonable interpretation and say what you did.
- You have his full dashboard data in the user message. Answer questions about todos, projects, habits, streaks, sleep, and mantras from it accurately.`;

async function askClaude(userMessage, context){
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `DASHBOARD DATA:\n${JSON.stringify(context)}\n\nSAMI'S MESSAGE:\n${userMessage}` }
      ]
    })
  });
  const data = await r.json();
  if(!data.content || !data.content[0]) throw new Error(data.error ? data.error.message : 'Empty AI response');
  const text = data.content.map(c => c.text || '').join('').trim();
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function runActions(supa, userId, actions){
  const results = [];
  for(const a of (actions||[])){
    try{
      if(a.type === 'create_todo'){
        await supa.from('todos').insert({
          user_id: userId, text: a.text, pri: a.pri || 'med',
          done: false, rank: 0, carried: false,
          due_at: a.due_at || null, completed_at: null, last_checkpoint_sent: null
        });
        results.push(`created: ${a.text}`);
      } else if(a.type === 'complete_todo'){
        const { data } = await supa.from('todos').select('id,text').eq('user_id', userId).eq('done', false).ilike('text', `%${a.match}%`).limit(1);
        if(data && data[0]){
          await supa.from('todos').update({ done: true, completed_at: new Date().toISOString() }).eq('id', data[0].id);
          results.push(`completed: ${data[0].text}`);
        } else results.push(`not found: ${a.match}`);
      } else if(a.type === 'delete_todo'){
        const { data } = await supa.from('todos').select('id,text').eq('user_id', userId).ilike('text', `%${a.match}%`).limit(1);
        if(data && data[0]){
          await supa.from('todos').delete().eq('id', data[0].id);
          results.push(`deleted: ${data[0].text}`);
        } else results.push(`not found: ${a.match}`);
      }
    }catch(e){ results.push(`failed: ${e.message}`); }
  }
  return results;
}

module.exports = async function handler(req, res){
  try{
    if(req.method !== 'POST'){ res.status(200).json({ok:true, note:'webhook alive'}); return; }
    const update = req.body;
    const msg = update && update.message;
    if(!msg || !msg.text){ res.status(200).json({ok:true}); return; }

    // Security: only respond to Sami's chat
    const allowedChat = String(process.env.TELEGRAM_CHAT_ID);
    if(String(msg.chat.id) !== allowedChat){ res.status(200).json({ok:true}); return; }

    const userId = process.env.COMMAND_CENTRE_USER_ID;
    const supa = db();

    const context = await gatherContext(supa, userId);
    let parsed;
    try{
      parsed = await askClaude(msg.text, context);
    }catch(e){
      await sendTelegram('Hmm, I had trouble understanding that (' + e.message + '). Try rephrasing?');
      res.status(200).json({ok:true});
      return;
    }

    await runActions(supa, userId, parsed.actions);
    await sendTelegram(parsed.reply || 'Done.');
    res.status(200).json({ok:true});
  }catch(err){
    console.error(err);
    try{ await sendTelegram('Something went wrong on my end: ' + err.message); }catch(e){}
    res.status(200).json({ok:true});
  }
};
