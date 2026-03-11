"""
TechStore Support Agent — Realistic Demo (No API Key Required)
==============================================================
Simulates a real GPT-5.2 powered customer support agent with:
  - Realistic LLM thinking delays
  - Real tool call decisions (order lookup, KB search, escalation)
  - Actual agent reasoning printed step by step
  - Live traces sent to the Observability Dashboard

Usage:
    python3 demo_agent.py
    python3 demo_agent.py "My order ORD-1004 is delayed"
"""

import sys
import json
import time
import random
from agent_sdk import AgentTracer

DASHBOARD_URL = "http://localhost:3001"
AGENT_NAME    = "support-agent-gpt52"
MODEL         = "gpt-5.2"

tracer = AgentTracer(
    endpoint=f"{DASHBOARD_URL}/api/agent/spans",
    flush_interval=2.0,
    debug=False
)

# ── KNOWLEDGE BASE ───────────────────────────────────────────
KNOWLEDGE_BASE = {
    "return policy":      "You can return any item within 30 days for a full refund. Items must be unused and in original packaging.",
    "shipping times":     "Standard shipping: 5-7 business days. Express: 1-2 days. Free shipping on orders over $50.",
    "warranty":           "All electronics come with a 1-year manufacturer warranty. Extended warranties available.",
    "payment methods":    "We accept Visa, Mastercard, Amex, PayPal, and Apple Pay. All transactions are SSL secured.",
    "cancel order":       "Orders can be cancelled within 1 hour of placement. After that, wait for delivery and initiate a return.",
    "discount codes":     "Discount codes apply at checkout. Case-sensitive, cannot be combined with other offers.",
    "account issues":     "Reset password via 'Forgot Password' on login page. Lockouts: contact support@techstore.com.",
    "product availability":"Check real-time stock on the product page. Add out-of-stock items to wishlist for restock alerts.",
}

ORDERS = {
    "ORD-1001": {"status": "delivered",  "item": "Smartphone Pro X",    "date": "2026-03-05", "tracking": "TRK9821"},
    "ORD-1002": {"status": "in_transit", "item": "Laptop Ultra",         "date": "2026-03-08", "tracking": "TRK4432"},
    "ORD-1003": {"status": "processing", "item": "Wireless Headphones",  "date": "2026-03-10", "tracking": None},
    "ORD-1004": {"status": "delayed",    "item": "Smart Watch",           "date": "2026-03-01", "tracking": "TRK7761"},
    "ORD-1005": {"status": "cancelled",  "item": "USB-C Hub",             "date": "2026-03-09", "tracking": None},
}

# ── TOOL IMPLEMENTATIONS ─────────────────────────────────────
def search_knowledge_base(query):
    time.sleep(random.uniform(0.1, 0.3))  # realistic tool latency
    q = query.lower()
    results = [{"topic": k, "content": v} for k, v in KNOWLEDGE_BASE.items()
               if any(w in q for w in k.split()) or any(w in k for w in q.split())]
    if not results:
        results = [{"topic": "general", "content": "Please contact support@techstore.com for further assistance."}]
    return {"results": results, "count": len(results)}

def check_order_status(order_id):
    time.sleep(random.uniform(0.2, 0.5))  # realistic DB lookup latency
    order = ORDERS.get(order_id.upper())
    if not order:
        return {"error": f"Order {order_id} not found. Please verify the order ID."}
    return {
        "order_id": order_id.upper(),
        "status": order["status"],
        "item": order["item"],
        "order_date": order["date"],
        "tracking_number": order["tracking"],
        "estimated_delivery": "2026-03-15" if order["status"] == "in_transit" else None
    }

def escalate_to_human(reason, priority):
    time.sleep(random.uniform(0.1, 0.2))
    ticket_id = f"TKT-{random.randint(10000, 99999)}"
    return {
        "ticket_id": ticket_id,
        "status": "created",
        "priority": priority,
        "reason": reason,
        "assigned_to": "Support Team",
        "estimated_response": "within 2 hours" if priority in ["high", "urgent"] else "within 24 hours"
    }

TOOL_FUNCTIONS = {
    "search_knowledge_base": search_knowledge_base,
    "check_order_status": check_order_status,
    "escalate_to_human": escalate_to_human,
}

# ── AGENT DECISION ENGINE (simulates GPT-5.2 reasoning) ─────
def agent_decide(query, context):
    """
    Simulates GPT-5.2's tool-use decisions based on the query.
    Returns a list of steps: [("tool", name, args), ..., ("respond", text)]
    """
    q = query.lower()
    steps = []

    # Order status queries
    import re
    order_match = re.search(r'ord-\d+', q)
    if order_match:
        order_id = order_match.group().upper()
        steps.append(("tool", "check_order_status", {"order_id": order_id}))
        order = ORDERS.get(order_id, {})
        status = order.get("status", "unknown")
        item = order.get("item", "your item")

        if status == "in_transit":
            steps.append(("respond",
                f"I checked your order **{order_id}** for the **{item}**. "
                f"It's currently **in transit** with tracking number {order.get('tracking')}. "
                f"Estimated delivery is March 15, 2026. You can track it on our website using the tracking number."))
        elif status == "delivered":
            steps.append(("respond",
                f"Your order **{order_id}** for the **{item}** was **delivered** on {order.get('date')}. "
                f"If you haven't received it, please check with neighbors or your building's mailroom. "
                f"If it's still missing, I can escalate this for you."))
        elif status == "delayed":
            steps.append(("tool", "escalate_to_human", {
                "reason": f"Order {order_id} for {item} is delayed since {order.get('date')}. Customer needs urgent update.",
                "priority": "high"
            }))
            steps.append(("respond",
                f"I'm sorry to hear your order **{order_id}** for the **{item}** is delayed. "
                f"I've escalated this to our support team with **high priority**. "
                f"You'll receive a response within 2 hours with a resolution or updated delivery date."))
        elif status == "processing":
            steps.append(("tool", "search_knowledge_base", {"query": "cancel order"}))
            steps.append(("respond",
                f"Your order **{order_id}** for the **{item}** is still **processing** (placed {order.get('date')}). "
                f"It hasn't shipped yet. If you'd like to cancel, you can do so within 1 hour of placement — "
                f"since it's still processing, please contact us immediately at support@techstore.com."))
        elif status == "cancelled":
            steps.append(("respond",
                f"Your order **{order_id}** for the **{item}** has been **cancelled**. "
                f"If you didn't request this cancellation, please contact support@techstore.com immediately. "
                f"Refunds typically appear within 5-7 business days."))
        else:
            steps.append(("respond", f"I found order {order_id} but couldn't determine its current status. Let me escalate this."))
        return steps

    # Policy / general questions
    if any(w in q for w in ["return", "refund", "policy"]):
        steps.append(("tool", "search_knowledge_base", {"query": "return policy"}))
        steps.append(("respond",
            "Our **return policy** allows you to return any item within **30 days** of purchase for a full refund. "
            "Items must be unused and in their original packaging. "
            "To start a return, visit your order history and click 'Return Item', or contact support@techstore.com."))

    elif any(w in q for w in ["ship", "delivery", "arrive", "when"]):
        steps.append(("tool", "search_knowledge_base", {"query": "shipping times"}))
        steps.append(("respond",
            "Our **shipping options** are:\n"
            "• **Standard shipping**: 5-7 business days (free on orders over $50)\n"
            "• **Express shipping**: 1-2 business days\n\n"
            "Once shipped, you'll receive a tracking number via email."))

    elif any(w in q for w in ["pay", "payment", "paypal", "visa", "card"]):
        steps.append(("tool", "search_knowledge_base", {"query": "payment methods"}))
        steps.append(("tool", "search_knowledge_base", {"query": "shipping times"}))
        steps.append(("respond",
            "Yes, we accept **PayPal**, Visa, Mastercard, Amex, and Apple Pay — all secured with SSL encryption.\n\n"
            "For shipping: **Standard** is 5-7 business days (free over $50), **Express** is 1-2 business days."))

    elif any(w in q for w in ["cancel", "cancell"]):
        steps.append(("tool", "search_knowledge_base", {"query": "cancel order"}))
        steps.append(("respond",
            "Orders can be **cancelled within 1 hour** of placement. After that, the order enters processing and cannot be cancelled directly.\n\n"
            "If it's been more than 1 hour, you'll need to wait for delivery and then initiate a return. "
            "Would you like me to check your specific order status?"))

    elif any(w in q for w in ["warranty", "broken", "defect", "repair"]):
        steps.append(("tool", "search_knowledge_base", {"query": "warranty"}))
        steps.append(("tool", "escalate_to_human", {
            "reason": "Customer reporting potential defective product or warranty claim",
            "priority": "medium"
        }))
        steps.append(("respond",
            "All our electronics come with a **1-year manufacturer warranty**. "
            "I've created a support ticket for your warranty claim — our team will contact you within 24 hours "
            "to guide you through the process."))

    else:
        steps.append(("tool", "search_knowledge_base", {"query": query}))
        steps.append(("tool", "escalate_to_human", {
            "reason": f"Customer query could not be automatically resolved: '{query}'",
            "priority": "low"
        }))
        steps.append(("respond",
            "Thank you for reaching out! I've searched our knowledge base and created a support ticket for your query. "
            "Our team will get back to you within 24 hours. "
            "For urgent issues, you can also reach us at support@techstore.com."))

    return steps

# ── MAIN AGENT RUNNER ────────────────────────────────────────
def run_agent(user_query, session_id=None, user_id=None):
    sid = session_id or f"session_{int(time.time())}"
    uid = user_id or f"user_{random.randint(1000,9999)}"

    print(f"\n{'='*60}")
    print(f"🤖 TechStore Support Agent (GPT-5.2)")
    print(f"{'='*60}")
    print(f"Query    : {user_query}")
    print(f"Session  : {sid}")
    print(f"User     : {uid}")
    print(f"Dashboard: {DASHBOARD_URL}")
    print(f"{'='*60}\n")

    final_response = None

    with tracer.trace(AGENT_NAME, session_id=sid, user_id=uid) as trace:

        # ── Step 1: LLM reasoning (GPT-5.2 decides what to do) ──
        print(f"[Step 1] GPT-5.2 reasoning about query...")
        with trace.span("llm_call", model=MODEL) as span:
            think_time = random.uniform(0.8, 2.0)
            time.sleep(think_time)
            prompt_tokens = random.randint(400, 800)
            completion_tokens = random.randint(80, 200)
            span.set_tokens(prompt=prompt_tokens, completion=completion_tokens)
            span.set_metadata(finish_reason="tool_calls", step=1)
        print(f"  🧠 GPT-5.2 → {prompt_tokens}+{completion_tokens} tokens | decided: use tools")

        # ── Steps 2+: Execute tool calls + final LLM response ──
        steps = agent_decide(user_query, {})
        step_num = 2

        for step in steps:
            if step[0] == "tool":
                _, tool_name, tool_args = step
                print(f"[Step {step_num}] Tool call: {tool_name}({json.dumps(tool_args)})")
                with trace.span("tool_call", tool_name=tool_name) as span:
                    span.set_input(tool_args)
                    result = TOOL_FUNCTIONS[tool_name](**tool_args)
                    span.set_output(result)
                print(f"  🔧 {tool_name} → {json.dumps(result)[:100]}...")
                step_num += 1

            elif step[0] == "respond":
                final_response = step[1]
                # Final LLM synthesis call
                print(f"[Step {step_num}] GPT-5.2 synthesizing final response...")
                with trace.span("llm_call", model=MODEL) as span:
                    synth_time = random.uniform(0.5, 1.5)
                    time.sleep(synth_time)
                    p_tokens = random.randint(600, 1200)
                    c_tokens = random.randint(100, 300)
                    span.set_tokens(prompt=p_tokens, completion=c_tokens)
                    span.set_metadata(finish_reason="stop", step=step_num)
                print(f"  🧠 GPT-5.2 → {p_tokens}+{c_tokens} tokens | finish: stop")
                print(f"\n✅ Agent finished in {step_num} steps")

    print(f"\n{'='*60}")
    print("💬 AGENT RESPONSE:")
    print(f"{'='*60}")
    print(final_response or "(no response)")
    print(f"{'='*60}")
    print(f"\n📊 Live trace → {DASHBOARD_URL} (Traces tab)")
    return final_response


# ── DEMO SCENARIOS ───────────────────────────────────────────
DEMO_QUERIES = [
    ("Where is my order ORD-1002?",                       "session_demo_1", "user_alice"),
    ("What is your return policy?",                       "session_demo_2", "user_bob"),
    ("My order ORD-1004 is delayed, I need help urgently!","session_demo_3", "user_carol"),
    ("Can I cancel my order ORD-1003?",                   "session_demo_4", "user_dave"),
    ("Do you accept PayPal and what are shipping times?",  "session_demo_5", "user_eve"),
]

if __name__ == "__main__":
    if len(sys.argv) > 1:
        query = " ".join(sys.argv[1:])
        run_agent(query)
    else:
        print("\n🚀 TechStore Support Agent — GPT-5.2 Live Demo")
        print("=" * 60)
        print("Sending real traces to the Observability Dashboard")
        print(f"Dashboard: {DASHBOARD_URL}\n")

        for i, (query, session, user) in enumerate(DEMO_QUERIES):
            print(f"\n{'#'*60}")
            print(f"# SCENARIO {i+1}/{len(DEMO_QUERIES)}")
            print(f"{'#'*60}")
            run_agent(query, session_id=session, user_id=user)
            if i < len(DEMO_QUERIES) - 1:
                print("\n⏳ Next scenario in 2 seconds...")
                time.sleep(2)

        print("\n\n🎉 All 5 scenarios complete!")
        print(f"📊 Dashboard: {DASHBOARD_URL}")
        print("   → Traces tab    : 5 agent runs with Gantt timelines")
        print("   → Incidents tab : any detected failures")
        print("   → Cost & Tokens : GPT-5.2 token usage per run")
        print("   → SLOs tab      : reliability targets")
