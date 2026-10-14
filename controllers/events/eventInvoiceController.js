// controllers/invoices/eventInvoiceController.js

import asyncHandler from 'express-async-handler';
import EventInvoice from '../../models/eventInvoice.js';
import PaidTicket from '../../models/paidTicket.js';
import { buildInvoiceDisplayLines } from '../../utils/events/ticketHelpers.js';

// @desc    Get invoice by invoice number
// @route   GET /api/invoices/:invoiceNumber
// @access  Private (User can view their own invoices, Organizers can view invoices for their events)
export const getInvoiceByNumber = asyncHandler(async (req, res) => {
  console.log('📋 Fetching invoice details');
  
  try {
    const { invoiceNumber } = req.params;
    const userId = req.user._id;

    // Find invoice by invoice number
    const invoice = await EventInvoice.findOne({ invoiceNumber })
      .populate('user', 'name email');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    // Access control: User can view their own invoices
    // Organizers can view invoices for their events (checked via eventSnapshot.postedBy)
    const isInvoiceOwner = invoice.user._id.toString() === userId.toString();
    const isEventOrganizer = invoice.eventSnapshot.postedBy === userId.toString();

    if (!isInvoiceOwner && !isEventOrganizer) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this invoice'
      });
    }

    // Format response data for frontend
    const responseData = {
      // Invoice Identity
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      status: invoice.status,
      
      // Event Information (from eventSnapshot)
      event: {
        title: invoice.eventSnapshot.title,
        dateTime: invoice.eventSnapshot.dateTime,
        timeZone: invoice.eventSnapshot.timeZone,
        venue: invoice.eventSnapshot.venue,
        address: invoice.eventSnapshot.address,
        category: invoice.eventSnapshot.category,
        eventCode: invoice.eventSnapshot.eventCode,
        organizer: {
          name: invoice.eventSnapshot.organizer?.name || '',
          email: invoice.eventSnapshot.organizer?.email || '',
          phone: invoice.eventSnapshot.organizer?.phone || '',
          abn: invoice.eventSnapshot.organizer?.abn || ''
        }
      },
      
      // Customer Information
      buyer: {
        firstName: invoice.buyer.firstName,
        lastName: invoice.buyer.lastName,
        email: invoice.buyer.email,
        phone: invoice.buyer.phone
      },
      
      // Ticket Line Items (raw, one per ticket - keeps ticketNumber/seat detail for the refund view)
      lineItems: invoice.lineItems.map(item => ({
        ticketNumber: item.ticketNumber,
        ticketType: {
          name: item.ticketType.name,
          price: item.ticketType.price
        },
        ...(item.pack && item.pack.id ? { pack: { id: item.pack.id, price: item.pack.price } } : {}),
        quantity: item.quantity,
        discountAmount: item.discountAmount || 0,
        seats: item.seats || [],
        attendeeName: item.attendeeName
      })),

      // Display line items (events-bundle-pricing.md D8): a bundle pack collapses into ONE line at
      // the pack price ("admits N" by count); singles group by type. Amounts are the exact stored
      // money, never a rounded per-ticket share x quantity - so no line ever reads $50.01.
      displayLineItems: buildInvoiceDisplayLines(invoice.lineItems),

      // Financial Summary
      amounts: {
        total: invoice.amounts.total,
        subtotal: invoice.amounts.subtotal,
        ...(invoice.amounts.discount ? { discount: invoice.amounts.discount } : {}),
        totalRefunded: invoice.amounts.totalRefunded,
        netAmount: invoice.amounts.netAmount
      },
      
      // Display Flags for Invoice
      gstIncluded: invoice.gstIncluded,
      refundPolicy: {
        processingFeePolicy: invoice.refundPolicy?.processingFeePolicy || '',
        policyText: invoice.refundPolicy?.policyText || '',
        termsAndConditions: invoice.refundPolicy?.termsAndConditions || ''
      },
      
      // Refund History
      refunds: invoice.refunds.map(refund => ({
  ticketNumber: refund.ticketNumber,
  refundRequestId: refund.refundRequestId,
  ticketNumbers: refund.ticketNumbers,
  refundAmount: refund.refundAmount,
  refundDate: refund.refundDate,
  stripeRefundId: refund.stripeRefundId,
  reason: refund.reason,
  processedBy: refund.processedBy
})),
      
      // Payment Information
      payment: {
        paymentIntentId: invoice.payment.paymentIntentId,
        stripeAccountId: invoice.payment.stripeAccountId,
        paymentDate: invoice.payment.paymentDate,
        currency: invoice.payment.currency
      },
      
      // Metadata
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt
    };

    console.log(`✅ Invoice ${invoiceNumber} retrieved successfully`);
    console.log(`📊 Invoice details: ${invoice.lineItems.length} items, $${invoice.amounts.total} total`);

    res.status(200).json({
      success: true,
      invoice: responseData
    });

  } catch (error) {
    console.error('❌ Error fetching invoice:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch invoice details',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// @desc    Get invoice by ticket number or invoice number
// @route   GET /api/events/invoices/lookup/:identifier
// @access  Private (User can view their own invoices, Organizers can view invoices for their events)
export const getInvoiceByIdentifier = asyncHandler(async (req, res) => {
  console.log('📋 Fetching invoice by identifier');
  
  try {
    const { identifier } = req.params;
    const userId = req.user._id;
    let invoiceNumber;

    // Step 1: Determine identifier type and get invoice number
    if (identifier.startsWith('TKT-')) {
      // Lookup by ticket number
      const ticket = await PaidTicket.findOne({ ticketNumber: identifier })
        .select('invoiceNumber');
      
      if (!ticket) {
        return res.status(404).json({
          success: false,
          message: 'Ticket not found'
        });
      }
      
      invoiceNumber = ticket.invoiceNumber;
      console.log(`🎫 Found invoice ${invoiceNumber} for ticket ${identifier}`);
      
    } else if (identifier.startsWith('INV-')) {
      // Direct invoice lookup
      invoiceNumber = identifier;
      console.log(`📋 Direct invoice lookup: ${invoiceNumber}`);
      
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid identifier. Must start with TKT- or INV-'
      });
    }

    // Step 2: Continue with existing invoice lookup logic
    // Find invoice by invoice number
    const invoice = await EventInvoice.findOne({ invoiceNumber })
      .populate('user', 'name email');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    // Access control: User can view their own invoices
    // Organizers can view invoices for their events (checked via eventSnapshot.postedBy)
    const isInvoiceOwner = invoice.user._id.toString() === userId.toString();
    const isEventOrganizer = invoice.eventSnapshot.postedBy === userId.toString();

    if (!isInvoiceOwner && !isEventOrganizer) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this invoice'
      });
    }

    // Format response data for frontend (same as existing function)
    const responseData = {
      // Invoice Identity
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      status: invoice.status,
      
      // Event Information (from eventSnapshot)
      event: {
        title: invoice.eventSnapshot.title,
        dateTime: invoice.eventSnapshot.dateTime,
        timeZone: invoice.eventSnapshot.timeZone,
        venue: invoice.eventSnapshot.venue,
        address: invoice.eventSnapshot.address,
        category: invoice.eventSnapshot.category,
        eventCode: invoice.eventSnapshot.eventCode,
        organizer: {
          name: invoice.eventSnapshot.organizer?.name || '',
          email: invoice.eventSnapshot.organizer?.email || '',
          phone: invoice.eventSnapshot.organizer?.phone || '',
          abn: invoice.eventSnapshot.organizer?.abn || ''
        }
      },
      
      // Customer Information
      buyer: {
        firstName: invoice.buyer.firstName,
        lastName: invoice.buyer.lastName,
        email: invoice.buyer.email,
        phone: invoice.buyer.phone
      },
      
      // Ticket Line Items (raw, one per ticket - keeps ticketNumber/seat detail for the refund view)
      lineItems: invoice.lineItems.map(item => ({
        ticketNumber: item.ticketNumber,
        ticketType: {
          name: item.ticketType.name,
          price: item.ticketType.price
        },
        ...(item.pack && item.pack.id ? { pack: { id: item.pack.id, price: item.pack.price } } : {}),
        quantity: item.quantity,
        discountAmount: item.discountAmount || 0,
        seats: item.seats || [],
        attendeeName: item.attendeeName
      })),

      // Display line items (events-bundle-pricing.md D8): a bundle pack collapses into ONE line at
      // the pack price ("admits N" by count); singles group by type. Amounts are the exact stored
      // money, never a rounded per-ticket share x quantity - so no line ever reads $50.01.
      displayLineItems: buildInvoiceDisplayLines(invoice.lineItems),

      // Financial Summary
      amounts: {
        total: invoice.amounts.total,
        subtotal: invoice.amounts.subtotal,
        ...(invoice.amounts.discount ? { discount: invoice.amounts.discount } : {}),
        totalRefunded: invoice.amounts.totalRefunded,
        netAmount: invoice.amounts.netAmount
      },
      
      // Display Flags for Invoice
      gstIncluded: invoice.gstIncluded,
      refundPolicy: {
        processingFeePolicy: invoice.refundPolicy?.processingFeePolicy || '',
        policyText: invoice.refundPolicy?.policyText || '',
        termsAndConditions: invoice.refundPolicy?.termsAndConditions || ''
      },
      
      // Refund History
      refunds: invoice.refunds.map(refund => ({
        ticketNumber: refund.ticketNumber,
        refundRequestId: refund.refundRequestId,
        ticketNumbers: refund.ticketNumbers,
        refundAmount: refund.refundAmount,
        refundDate: refund.refundDate,
        stripeRefundId: refund.stripeRefundId,
        reason: refund.reason,
        processedBy: refund.processedBy
      })),
      
      // Payment Information
      payment: {
        paymentIntentId: invoice.payment.paymentIntentId,
        stripeAccountId: invoice.payment.stripeAccountId,
        paymentDate: invoice.payment.paymentDate,
        currency: invoice.payment.currency
      },
      
      // Metadata
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt
    };

    console.log(`✅ Invoice ${invoiceNumber} retrieved successfully via ${identifier}`);
    console.log(`📊 Invoice details: ${invoice.lineItems.length} items, $${invoice.amounts.total} total`);

    res.status(200).json({
      success: true,
      invoice: responseData
    });

  } catch (error) {
    console.error('❌ Error fetching invoice by identifier:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch invoice details',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @desc    Get all invoices for a user
// @route   GET /api/events/invoices/my-invoices
// @access  Private (User can view their own invoices)
export const getUserInvoices = asyncHandler(async (req, res) => {
  console.log('📋 Fetching user invoices');
  
  try {
    const userId = req.user._id;
    const { page = 1, limit = 20, eventId = '' } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build query
    let query = { 'user': userId };
    
    // Filter by event if provided
    if (eventId) {
      query['event'] = eventId;
    }

    // Get total count for pagination
    const totalInvoices = await EventInvoice.countDocuments(query);
    const totalPages = Math.ceil(totalInvoices / limitNum);

    // Find user's invoices with pagination
    const invoices = await EventInvoice.find(query)
      .sort({ createdAt: -1 }) // Newest first
      .skip(skip)
      .limit(limitNum)
      .populate('user', 'name email');

    // Format response data for frontend
    const formattedInvoices = invoices.map(invoice => ({
      // Invoice Identity
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      status: invoice.status,
      
      // Event Information (from eventSnapshot)
      event: {
        title: invoice.eventSnapshot.title,
        dateTime: invoice.eventSnapshot.dateTime,
        timeZone: invoice.eventSnapshot.timeZone,
        venue: invoice.eventSnapshot.venue,
        address: invoice.eventSnapshot.address,
        category: invoice.eventSnapshot.category,
        eventCode: invoice.eventSnapshot.eventCode,
        organizer: {
          name: invoice.eventSnapshot.organizer?.name || '',
          email: invoice.eventSnapshot.organizer?.email || '',
          phone: invoice.eventSnapshot.organizer?.phone || '',
          abn: invoice.eventSnapshot.organizer?.abn || ''
        }
      },
      
      // Customer Information
      buyer: {
        firstName: invoice.buyer.firstName,
        lastName: invoice.buyer.lastName,
        email: invoice.buyer.email,
        phone: invoice.buyer.phone
      },
      
      // Ticket Summary
      ticketCount: invoice.lineItems.length,
      
      // Financial Summary
      amounts: {
        total: invoice.amounts.total,
        subtotal: invoice.amounts.subtotal,
        ...(invoice.amounts.discount ? { discount: invoice.amounts.discount } : {}),
        totalRefunded: invoice.amounts.totalRefunded,
        netAmount: invoice.amounts.netAmount
      },
      
      // Refund Summary
      refundCount: invoice.refunds.length,
      hasRefunds: invoice.refunds.length > 0,
      // Slim refund entries so the list can render a link per refund transaction
      refunds: invoice.refunds.map(r => ({
        refundRequestId: r.refundRequestId,
        ticketNumber: r.ticketNumber,
        refundAmount: r.refundAmount,
        refundDate: r.refundDate,
        stripeRefundId: r.stripeRefundId,
      })),
      
      // Metadata
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt
    }));

    console.log(`✅ Found ${invoices.length} invoices for user ${userId}`);

    res.status(200).json({
      success: true,
      invoices: formattedInvoices,
      count: formattedInvoices.length,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalInvoices,
        hasMore: pageNum < totalPages
      }
    });

  } catch (error) {
    console.error('❌ Error fetching user invoices:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch invoices',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});