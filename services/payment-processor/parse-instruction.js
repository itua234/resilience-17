const validator = require('@app-core/validator');
const { throwAppError, ERROR_CODE } = require('@app-core/errors');
const { appLogger } = require('@app-core/logger');
const PaymentMessages = require('@app/messages/payment'); 

const spec = `root {
    accounts[] {
        id string
        balance number
        currency string
    }
    instruction string
}`;
const parsedSpec = validator.parse(spec);

async function parseInstruction(serviceData) {
    let response;

    try {
        const data = validator.validate(serviceData, parsedSpec);
        const processedAccounts = (data.accounts || []).map((a) => ({
            id: a.id,
            balance: a.balance,
            currency: a.currency,
            balance_before: a.balance
        }));
        for (let i = 0; i < data.accounts.length; i++) {
            data.accounts[i].balance_before = data.accounts[i].balance;
        }

        const parsed = parse(data.instruction);
        if (!parsed || parsed.error) {
            throwAppError(
                parsed.statusReason, 
                ERROR_CODE.INVLDDATA,
                {
                    details: {
                        type: null,
                        amount: null,
                        currency: null,
                        debit_account: null,
                        credit_account: null,
                        execute_by: null,
                        status: "failed",
                        statusCode: parsed.statusCode,
                        statusReason: parsed.statusReason,
                        accounts: []
                    }
                }
            );
        }

        const validation = validateTransaction(parsed, data.accounts);
        if(!validation.valid){
            throwAppError(
                validation.error.statusReason, 
                ERROR_CODE.INVLDDATA,
                {
                    details: {
                        type: null,
                        amount: null,
                        currency: null,
                        debit_account: null,
                        credit_account: null,
                        execute_by: null,
                        status: "failed",
                        status_reason: validation.error.statusReason,
                        status_code: validation.error.statusCode,
                        accounts: []
                    }
                }
            );
        }

        if(parsed.date){
            if (isDateInFuture(parsed.date)) {
                return { 
                    type: parsed.type,
                    amount: parsed.amount,
                    currency: parsed.currency,
                    debit_account: data.accounts[0].id,
                    credit_account: data.accounts[1].id,
                    execute_by: parsed.date || null,
                    status: "pending",
                    status_reason: PaymentMessages.TRANSACTION_PENDING,
                    status_code: "AP02",
                    accounts: [validation.sourceAccount, validation.destinationAccount]
                };
            }
        }
        validation.sourceAccount.balance -= parsed.amount;
        validation.destinationAccount.balance += parsed.amount;

        response = {
            type: parsed.type,
            amount: parsed.amount,
            currency: parsed.currency,
            debit_account: data.accounts[0].id,
            credit_account: data.accounts[1].id,
            execute_by: parsed.date || null,
            status: "successful",
            status_reason: PaymentMessages.TRANSACTION_SUCCESSFUL,
            status_code: "AP00",
            accounts: [validation.sourceAccount, validation.destinationAccount]
        };
    } catch (error) {
        // Log and rethrow so upstream handlers can return the appropriate error response
        appLogger.errorX(error, 'parse-instruction-error');
        throw error;
    }

    return response;
}

function parse(instruction) {
    instruction = instruction.trim().replace(/\s+/g, ' ');
    const type = instruction.split(' ')[0].toUpperCase();
    if (type === 'DEBIT') {
        return parseDebitInstruction(instruction);
    } else if (type === 'CREDIT') {
        return parseCreditInstruction(instruction);
    } else {
        return {
            error: true,
            statusCode: 'SY03',
            statusReason: PaymentMessages.MALFORMED_INSTRUCTION
        };
    }
}

function parseDebitInstruction(instruction) {
    const requiredKeywords = ['DEBIT', 'FROM', 'ACCOUNT', 'FOR', 'CREDIT', 'TO', 'ACCOUNT'];
    const upperInstruction = instruction.toUpperCase();
    for (let i = 0; i < requiredKeywords.length; i++) {
        if (upperInstruction.indexOf(requiredKeywords[i]) === -1) {
            return {
                error: true,
                statusCode: 'SY01',
                statusReason: PaymentMessages.MISSING_KEYWORD
            };
        }
    }
    const parts = instruction.split(' ');
    if (parts.length < 11) {
        return {
            error: true,
            statusCode: 'SY01',
            statusReason: PaymentMessages.MISSING_KEYWORD
        };
    }
    if (parts[0].toUpperCase() !== 'DEBIT' ||
        parts[3].toUpperCase() !== 'FROM' ||
        parts[4].toUpperCase() !== 'ACCOUNT' ||
        parts[6].toUpperCase() !== 'FOR' ||
        parts[7].toUpperCase() !== 'CREDIT' ||
        parts[8].toUpperCase() !== 'TO' ||
        parts[9].toUpperCase() !== 'ACCOUNT') {
        return {
            error: true,
            statusCode: 'SY02',
            statusReason: PaymentMessages.INVALID_KEYWORD_ORDER
        };
    }
    
    const amount = parseFloat(parts[1]);
    const currency = parts[2].toUpperCase();
    const sourceAccount = parts[5];
    const destinationAccount = parts[10];
    
    let date = null;
    if (parts.length > 11) {
        if (parts[11].toUpperCase() === 'ON') {
            date = parts.slice(12).join(' ');
        } else {
            return {
                error: true,
                statusCode: 'SY03',
                statusReason: PaymentMessages.MALFORMED_INSTRUCTION
            };
        }
    }
    
    const result = {
        type: 'DEBIT',
        amount: amount,
        currency: currency,
        sourceAccount: sourceAccount,
        destinationAccount: destinationAccount,
        ...(date ? {date: date}: {})
    };
    return result;
}

function parseCreditInstruction(instruction) {  
    const requiredKeywords = ['CREDIT', 'TO', 'ACCOUNT', 'FOR', 'DEBIT', 'FROM', 'ACCOUNT'];
    const upperInstruction = instruction.toUpperCase();
    for (let i = 0; i < requiredKeywords.length; i++) {
        if (upperInstruction.indexOf(requiredKeywords[i]) === -1) {
            return {
                error: true,
                statusCode: 'SY01',
                statusReason: PaymentMessages.MISSING_KEYWORD
            };
        }
    }  
    const parts = instruction.split(' ');
    if (parts.length < 11) {
        return {
            error: true,
            statusCode: 'SY01',
            statusReason: PaymentMessages.MISSING_KEYWORD
        };
    }
    if (parts[0].toUpperCase() !== 'CREDIT' ||
        parts[3].toUpperCase() !== 'TO' ||
        parts[4].toUpperCase() !== 'ACCOUNT' ||
        parts[6].toUpperCase() !== 'FOR' ||
        parts[7].toUpperCase() !== 'DEBIT' ||
        parts[8].toUpperCase() !== 'FROM' ||
        parts[9].toUpperCase() !== 'ACCOUNT') {
        return {
            error: true,
            statusCode: 'SY02',
            statusReason: PaymentMessages.INVALID_KEYWORD_ORDER
        };
    }
    
    const amount = parseFloat(parts[1]);
    const currency = parts[2].toUpperCase();
    const destinationAccount = parts[5]; 
    const sourceAccount = parts[10]; 
    
    let date = null;
    if (parts.length > 11) {
        if (parts[11].toUpperCase() === 'ON') {
            date = parts.slice(12).join(' ');
        } else {
            return {
                error: true,
                statusCode: 'SY03',
                statusReason: PaymentMessages.MALFORMED_INSTRUCTION
            };
        }
    }
    
    const result = {
        type: 'CREDIT',
        amount: amount,
        currency: currency,
        sourceAccount: sourceAccount,
        destinationAccount: destinationAccount,
        ...(date ? {date: date}: {})
    };
    return result;
}

function validateTransaction(parsed, accounts) {
    const sourceAccount = accounts.find(acc => acc.id === parsed.sourceAccount);
    const destinationAccount = accounts.find(acc => acc.id === parsed.destinationAccount);
    let currencies = ["NGN", "USD", "GBP", "GHS"];
    const errors = [];
    if (!isValidAccount(sourceAccount.id)) {
        errors.push({
            error: true,
            statusCode: 'AC04',
            statusReason: PaymentMessages.INVALID_ACCOUNT_ID
        });
    }
    if (!isValidAccount(destinationAccount.id)) {
        errors.push({
            error: true,
            statusCode: 'AC04',
            statusReason: PaymentMessages.INVALID_ACCOUNT_ID
        });
    }
    if (isNaN(parsed.amount) || parsed.amount <= 0 || !Number.isInteger(parsed.amount)) {
        errors.push({
            error: true,
            statusCode: 'AM01',
            statusReason: PaymentMessages.INVALID_AMOUNT
        });
    }
    if(parsed.date){
        if (!isValidDate(parsed.date)) {
            errors.push({
                error: true,
                statusCode: 'DT01',
                statusReason: PaymentMessages.INVALID_DATE_FORMAT
            });
        }
    }
    if (sourceAccount.balance < parsed.amount) {
        errors.push({
            error: true,
            statusCode: 'AC01',
            statusReason: PaymentMessages.INSUFFICIENT_FUNDS
        });
    }
    if (parsed.sourceAccount === parsed.destinationAccount) {
        errors.push({
            error: true,
            statusCode: 'AC02',
            statusReason: PaymentMessages.SAME_ACCOUNT_ERROR
        });
    }
    if (!currencies.includes(parsed.currency)) {
        errors.push({
            error: true,
            statusCode: 'CU02',
            statusReason: PaymentMessages.UNSUPPORTED_CURRENCY
        });
    }
    if (accounts.length != 2) {
        errors.push({
            error: true,
            statusCode: 'AC03',
            statusReason: PaymentMessages.ACCOUNT_NOT_FOUND
        });
        return { valid: false, error: errors[0] };
    }
    if (sourceAccount.currency !== parsed.currency) {
        errors.push({
            error: true,
            statusCode: 'CU01',
            statusReason: PaymentMessages.CURRENCY_MISMATCH
        });
    }
    if (destinationAccount.currency !== parsed.currency) {
        errors.push({
            error: true,
            statusCode: 'CU01',
            statusReason: PaymentMessages.CURRENCY_MISMATCH
        });
    }
    
    if (errors.length > 0) {
        return { valid: false, error: errors[0] };
    }
    
    return { 
        valid: true, 
        sourceAccount, 
        destinationAccount 
    };
}

function isValidAccount(accountId) {
    const allowedChars = new Set([
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
        'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
        'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
        'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
        '-', '.', '@'
    ]);
    for (let i = 0; i < accountId.length; i++) {
        const char = accountId[i];
       if (!allowedChars.has(char)) {
            return false;
        }
    }
    return true;
}

function isValidDate(dateString) {
    if (dateString.length !== 10) return false;
    if (dateString[4] !== '-' || dateString[7] !== '-') return false;
    
    const year = dateString.substring(0, 4);
    const month = dateString.substring(5, 7);
    const day = dateString.substring(8, 10);
    
    for (let i = 0; i < year.length; i++) {
        if (year[i] < '0' || year[i] > '9') return false;
    }
    for (let i = 0; i < month.length; i++) {
        if (month[i] < '0' || month[i] > '9') return false;
    }
    for (let i = 0; i < day.length; i++) {
        if (day[i] < '0' || day[i] > '9') return false;
    }
    
    const yearNum = parseInt(year);
    const monthNum = parseInt(month);
    const dayNum = parseInt(day);
    
    if (yearNum < 1000 || yearNum > 9999) return false;
    if (monthNum < 1 || monthNum > 12) return false;
    if (dayNum < 1 || dayNum > 31) return false;
    
    return true;
}

function isDateInFuture(dateString) {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    const currentDay = now.getUTCDate();
    
    const year = parseInt(dateString.substring(0, 4));
    const month = parseInt(dateString.substring(5, 7));
    const day = parseInt(dateString.substring(8, 10));
    
    if (year > currentYear) return true;
    if (year < currentYear) return false;
    
    if (month > currentMonth) return true;
    if (month < currentMonth) return false;
    
    if (day > currentDay) return true;
    
    return false; 
}

module.exports = parseInstruction;