import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

interface BankWebhookPayload {
  reference?: string;
  amt?: string;
  timestamp?: string;
}

export async function POST(request: NextRequest) {
  try {
    // IP Whitelisting
    const allowedIPs = (process.env.ALLOWED_IPS || '').split(',').filter(Boolean);
    if (allowedIPs.length > 0) {
      const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() 
                    || request.headers.get('x-real-ip')?.trim() 
                    || '';
      
      if (!allowedIPs.includes(clientIP)) {
        console.log(`IP blocked: ${clientIP}. Allowed: ${allowedIPs.join(', ')}`);
        return NextResponse.json(
          { message: 'IP not allowed' },
          { status: 401 }
        );
      }
    }

    const apiKey = request.headers.get('x-api-key');
    const contentType = request.headers.get('content-type');
    const expectedApiKey = process.env.PEOPLES_BANK_API_KEY;

    if (!apiKey || !contentType || apiKey !== expectedApiKey) {
      return NextResponse.json(
        { message: 'invalid headers' },
        { status: 401 }
      );
    }

    let body: BankWebhookPayload;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          transactionStatus: '97',
          statusDescription: 'Invalid request body',
        },
        { status: 200 }
      );
    }

    const errors: string[] = [];
    if (!body.reference) {
      errors.push('The reference field is required.');
    }
    if (!body.amt) {
      errors.push('The amt field is required.');
    }
    if (!body.timestamp) {
      errors.push('The timestamp field is required.');
    }

    if (errors.length > 0) {
      return NextResponse.json(
        {
          transactionStatus: '97',
          statusDescription: errors.join(' '),
        },
        { status: 200 }
      );
    }

    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('id, status, amount')
      .eq('reference_no', body.reference)
      .single();

    if (fetchError || !transaction) {
      const { data: completedTransaction } = await supabase
        .from('completed_transactions')
        .select('id')
        .eq('reference_no', body.reference)
        .single();

      if (completedTransaction) {
        return NextResponse.json(
          {
            transactionStatus: '98',
            statusDescription: 'Already Processed',
          },
          { status: 200 }
        );
      }

      return NextResponse.json(
        {
          transactionStatus: '99',
          statusDescription: 'Reference Number Not Found',
        },
        { status: 200 }
      );
    }

    if (transaction.status === 'completed') {
      return NextResponse.json(
        {
          transactionStatus: '98',
          statusDescription: 'Already Processed',
        },
        { status: 200 }
      );
    }

    const { data: fullTransaction } = await supabase
      .from('transactions')
      .select('id, local_id, merchant_id, reference_no, amount, tag')
      .eq('id', transaction.id)
      .single();

    if (!fullTransaction) {
      return NextResponse.json(
        {
          transactionStatus: '99',
          statusDescription: 'Failed to update transaction',
        },
        { status: 200 }
      );
    }

    const { error: insertError } = await supabase
      .from('completed_transactions')
      .upsert(
        {
          id: fullTransaction.id,
          local_id: fullTransaction.local_id,
          merchant_id: fullTransaction.merchant_id,
          reference_no: fullTransaction.reference_no,
          amount: fullTransaction.amount,
          tag: fullTransaction.tag,
          created_at: new Date().toISOString(),
        },
        { onConflict: 'reference_no', ignoreDuplicates: true }
      );

    if (insertError) {
      console.error('Failed to insert to completed_transactions:', insertError);
      return NextResponse.json(
        {
          transactionStatus: '99',
          statusDescription: 'Failed to update transaction',
        },
        { status: 200 }
      );
    }

    await supabase.from('transactions').delete().eq('id', transaction.id);

    console.log(`Transaction ${body.reference} moved to completed_transactions`);
    return NextResponse.json(
      { transactionStatus: '00' },
      { status: 200 }
    );
  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json(
      {
        transactionStatus: '96',
        statusDescription: 'Internal server error',
      },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json(
    {},
    {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
      },
    }
  );
}
