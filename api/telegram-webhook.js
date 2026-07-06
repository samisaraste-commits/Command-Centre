const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://wdtcygterxwqqashtqkr.supabase.co';
const DASH_URL = 'https://command-centre-liard.vercel.app';

function db(){
  return createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function sendTelegram(text){
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: '\u2197 Open dashboard', url: DASH_URL }]] } })
  });
}

function todayHelsinki(){
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Helsinki' });
}
function helsinkiNowISO(){
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Helsinki' }).replace(' ', 'T');
}

async function gatherContext(supa, userId){
  const [{ data: todos }, { data: projects }, { data: habits }, { data: mantraRow }, { data: sleep }, { data: notes }] = await Promise.all([
    supa.from('todos').select('text,pri,done,due_at,completed_at').eq('user_id', userId),
    supa.from('projects').select('name,pct,due,tags,tasks,done,archived').eq('user_id', userId).eq('archived', false),
    supa.from('habits').select('name,icon,cat,type,streak,pb,status,history').eq('user_id', userId),
    supa.from('mantras').select('content').eq('user_id', userId).maybeSingle(),
    supa.from('sleep_logs').select('log_date,score,note').eq('user_id', userId).order('log_date', {ascending:false}).limit(21),
    supa.from('notes').select('content,created_at').eq('user_id', userId).order('created_at', {ascending:false}).limit(50)
  ]);
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
    sleep_last_21_days: sleep||[],
    notes: notes||[]
  };
}

const SYSTEM_PROMPT = `You are the assistant inside "Command Centre", Sami's personal life dashboard. You receive his Telegram messages and must respond with ONLY a JSON object (no markdown, no backticks, no prose outside the JSON).

The JSON must have this shape:
{
  "actions": [ ... zero or more action objects ... ],
  "reply": "the message to send back to Sami in Telegram"
}

Supported actions:

TO-DOS:
- {"type":"create_todo","text":"...","pri":"high"|"med"|"low","due_at":"ISO UTC datetime or null"}
- {"type":"update_todo","match":"find by text","text":"new text or null","pri":"new pri or null","due_at":"new ISO UTC or null (null = leave unchanged)","clear_due":true|false}
- {"type":"complete_todo","match":"..."}
- {"type":"uncomplete_todo","match":"..."}
- {"type":"delete_todo","match":"..."}

HABITS:
- {"type":"create_habit","name":"...","cat":"MIND"|"BODY"|"SLEEP"|"WORK"|"OTHER","icon":"single emoji"}
- {"type":"set_habit_today","match":"find by name","status":"done"|"partial"|"missed"|"pending"}  (sets today's state; pending = clear today)
- {"type":"rename_habit","match":"...","name":"new name"}
- {"type":"delete_habit","match":"..."}

PROJECTS:
- {"type":"create_project","name":"...","due":"free text deadline or 'No deadline'","tags":["tag1"],"tasks":["task1"]}
- {"type":"update_project","match":"find by name","name":null,"pct":0-100 or null,"due":null,"add_task":"task text or null"}
- {"type":"complete_project","match":"..."}
- {"type":"delete_project","match":"..."}

MANTRAS:
- {"type":"add_mantra","text":"..."}
- {"type":"remove_mantra","match":"substring of the mantra"}
- {"type":"replace_mantra","match":"substring","text":"new wording"}

SLEEP:
- {"type":"log_sleep","score":0-10,"note":"optional","date":"YYYY-MM-DD or null for today"}

NOTES:
- {"type":"create_note","content":"the note text, verbatim or lightly cleaned up"}
- {"type":"delete_note","match":"substring of the note"}
- If Sami sends a thought, idea, or observation and asks to save/note it (or it clearly reads as a note), create a note with it.

Rules:
- Times Sami mentions are Helsinki time (UTC+3 in summer). Convert to UTC for due_at.
- Reminders: the system pings automatically at 24h,12h,10h,8h,6h,4h,2h before due and at expiry.
- Default priority "med". For questions, use empty actions and answer from context.
- Be concise, warm, direct. Plain text replies, no markdown. Helsinki local times in replies.
- Do the most reasonable interpretation of ambiguous requests and say what you did.
- You can chain multiple actions in one message when asked.
- You have his full dashboard data in the user message: todos, projects, habits (with 14-day history), mantras, sleep. Answer accurately from it.`;

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
      max_tokens: 1200,
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

async function findOne(supa, table, userId, field, match, extra){
  let q = supa.from(table).select('*').eq('user_id', userId).ilike(field, `%${match}%`).limit(1);
  if(extra) q = extra(q);
  const { data } = await q;
  return (data && data[0]) || null;
}

function histAsMap(h){
  let hist = h.history || {};
  if(Array.isArray(hist)){ const m={}; hist.forEach(d=>m[d]='done'); hist=m; }
  return hist;
}

async function runActions(supa, userId, actions){
  const results = [];
  for(const a of (actions||[])){
    try{
      /* ---- TODOS ---- */
      if(a.type === 'create_todo'){
        await supa.from('todos').insert({ user_id:userId, text:a.text, pri:a.pri||'med', done:false, rank:0, carried:false, due_at:a.due_at||null, completed_at:null, last_checkpoint_sent:null });
        results.push(`todo created: ${a.text}`);
      } else if(a.type === 'update_todo'){
        const t = await findOne(supa,'todos',userId,'text',a.match);
        if(!t){ results.push(`todo not found: ${a.match}`); continue; }
        const upd = {};
        if(a.text) upd.text = a.text;
        if(a.pri) upd.pri = a.pri;
        if(a.clear_due){ upd.due_at = null; upd.last_checkpoint_sent = null; }
        else if(a.due_at){ upd.due_at = a.due_at; upd.last_checkpoint_sent = null; }
        await supa.from('todos').update(upd).eq('id', t.id);
        results.push(`todo updated: ${t.text}`);
      } else if(a.type === 'complete_todo'){
        const t = await findOne(supa,'todos',userId,'text',a.match,q=>q.eq('done',false));
        if(!t){ results.push(`todo not found: ${a.match}`); continue; }
        await supa.from('todos').update({ done:true, completed_at:new Date().toISOString() }).eq('id', t.id);
        results.push(`todo completed: ${t.text}`);
      } else if(a.type === 'uncomplete_todo'){
        const t = await findOne(supa,'todos',userId,'text',a.match,q=>q.eq('done',true));
        if(!t){ results.push(`todo not found: ${a.match}`); continue; }
        await supa.from('todos').update({ done:false, completed_at:null }).eq('id', t.id);
        results.push(`todo reopened: ${t.text}`);
      } else if(a.type === 'delete_todo'){
        const t = await findOne(supa,'todos',userId,'text',a.match);
        if(!t){ results.push(`todo not found: ${a.match}`); continue; }
        await supa.from('todos').delete().eq('id', t.id);
        results.push(`todo deleted: ${t.text}`);

      /* ---- HABITS ---- */
      } else if(a.type === 'create_habit'){
        await supa.from('habits').insert({ user_id:userId, name:a.name, icon:a.icon||'\u2b50', cat:a.cat||'OTHER', type:'binary', streak:0, pb:0, status:'pending', rating:0, freezes:0, last_reset_date:todayHelsinki(), history:{} });
        results.push(`habit created: ${a.name}`);
      } else if(a.type === 'set_habit_today'){
        const h = await findOne(supa,'habits',userId,'name',a.match);
        if(!h){ results.push(`habit not found: ${a.match}`); continue; }
        const map = histAsMap(h);
        const d = todayHelsinki();
        let status = a.status || 'done';
        if(status === 'pending'){ delete map[d]; } else { map[d] = status; }
        let streak = h.streak || 0;
        if(status === 'done' && streak === 0) streak = 1;
        await supa.from('habits').update({ status, history: map, streak }).eq('id', h.id);
        results.push(`habit "${h.name}" today: ${status}`);
      } else if(a.type === 'rename_habit'){
        const h = await findOne(supa,'habits',userId,'name',a.match);
        if(!h){ results.push(`habit not found: ${a.match}`); continue; }
        await supa.from('habits').update({ name: a.name }).eq('id', h.id);
        results.push(`habit renamed to: ${a.name}`);
      } else if(a.type === 'delete_habit'){
        const h = await findOne(supa,'habits',userId,'name',a.match);
        if(!h){ results.push(`habit not found: ${a.match}`); continue; }
        await supa.from('habits').delete().eq('id', h.id);
        results.push(`habit deleted: ${h.name}`);

      /* ---- PROJECTS ---- */
      } else if(a.type === 'create_project'){
        await supa.from('projects').insert({ user_id:userId, name:a.name, pct:0, due:a.due||'No deadline', tags:a.tags||[], tasks:a.tasks||[], done:false, archived:false, archived_date:null });
        results.push(`project created: ${a.name}`);
      } else if(a.type === 'update_project'){
        const p = await findOne(supa,'projects',userId,'name',a.match,q=>q.eq('archived',false));
        if(!p){ results.push(`project not found: ${a.match}`); continue; }
        const upd = {};
        if(a.name) upd.name = a.name;
        if(a.pct !== null && a.pct !== undefined) upd.pct = Math.max(0, Math.min(100, a.pct));
        if(a.due) upd.due = a.due;
        if(a.add_task){ upd.tasks = [...(p.tasks||[]), a.add_task]; }
        await supa.from('projects').update(upd).eq('id', p.id);
        results.push(`project updated: ${p.name}`);
      } else if(a.type === 'complete_project'){
        const p = await findOne(supa,'projects',userId,'name',a.match,q=>q.eq('archived',false));
        if(!p){ results.push(`project not found: ${a.match}`); continue; }
        await supa.from('projects').update({ done:true, pct:100 }).eq('id', p.id);
        results.push(`project completed: ${p.name}`);
      } else if(a.type === 'delete_project'){
        const p = await findOne(supa,'projects',userId,'name',a.match);
        if(!p){ results.push(`project not found: ${a.match}`); continue; }
        await supa.from('projects').delete().eq('id', p.id);
        results.push(`project deleted: ${p.name}`);

      /* ---- MANTRAS (single row, newline-joined content) ---- */
      } else if(a.type === 'add_mantra' || a.type === 'remove_mantra' || a.type === 'replace_mantra'){
        const { data: row } = await supa.from('mantras').select('*').eq('user_id', userId).maybeSingle();
        let lines = (row && row.content) ? row.content.split('\n').filter(Boolean) : [];
        if(a.type === 'add_mantra'){
          lines.push(a.text);
          results.push(`mantra added: ${a.text}`);
        } else {
          const idx = lines.findIndex(l => l.toLowerCase().includes((a.match||'').toLowerCase()));
          if(idx === -1){ results.push(`mantra not found: ${a.match}`); continue; }
          if(a.type === 'remove_mantra'){ results.push(`mantra removed: ${lines[idx]}`); lines.splice(idx,1); }
          else { results.push(`mantra updated: ${a.text}`); lines[idx] = a.text; }
        }
        const content = lines.join('\n');
        if(row){ await supa.from('mantras').update({ content }).eq('user_id', userId); }
        else { await supa.from('mantras').insert({ user_id:userId, content }); }

      /* ---- NOTES ---- */
      } else if(a.type === 'create_note'){
        await supa.from('notes').insert({ user_id:userId, content:a.content });
        results.push(`note saved`);
      } else if(a.type === 'delete_note'){
        const n = await findOne(supa,'notes',userId,'content',a.match);
        if(!n){ results.push(`note not found: ${a.match}`); continue; }
        await supa.from('notes').delete().eq('id', n.id);
        results.push(`note deleted`);

      /* ---- SLEEP ---- */
      } else if(a.type === 'log_sleep'){
        const d = a.date || todayHelsinki();
        await supa.from('sleep_logs').upsert({ user_id:userId, log_date:d, score:a.score, note:a.note||'', updated_at:new Date().toISOString() });
        results.push(`sleep logged ${d}: ${a.score}/10`);
      }
    }catch(e){ results.push(`failed (${a.type}): ${e.message}`); }
  }
  return results;
}

module.exports = async function handler(req, res){
  try{
    if(req.method !== 'POST'){ res.status(200).json({ok:true, note:'webhook alive'}); return; }
    const update = req.body;
    const msg = update && update.message;
    if(!msg || !msg.text){ res.status(200).json({ok:true}); return; }

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
