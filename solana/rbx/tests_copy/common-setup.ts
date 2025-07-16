import * as anchor from "@coral-xyz/anchor";
import {
    Keypair,
    PublicKey,
    SystemProgram,
    LAMPORTS_PER_SOL
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { BN } from "bn.js";
import * as ethers from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// The program ID comes from the IDL
export const programId = new PublicKey("CZBh9LezU7rC2vpxCBs8w1TSFYmHDjU2WmWYkkcocq9W");

// Connection setup
export const opts = {
    preflightCommitment: "confirmed" as anchor.web3.Commitment,
    commitment: "confirmed" as anchor.web3.Commitment,
    skipPreflight: false,
};

export const connection = new anchor.web3.Connection(
    "http://localhost:8899",
    opts.commitment
);

export const confirmOpts = {
    skipPreflight: opts.skipPreflight,
    commitment: opts.commitment,
    preflightCommitment: opts.preflightCommitment,
};

export const wallet = anchor.Wallet.local();
export const provider = new anchor.AnchorProvider(connection, wallet, confirmOpts);
anchor.setProvider(provider);

// Load the program
export const program = anchor.workspace.Rbx;

// Test accounts
export const admin = Keypair.generate();
export const timelockAuthority = Keypair.generate();
export const user = Keypair.generate();

// Use a fixed private key for the signer in tests
export const signerWallet = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

// PDAs
export const statePda = PublicKey.findProgramAddressSync(
    [Buffer.from("state")],
    program.programId
)[0];

export const tokenAuthPda = PublicKey.findProgramAddressSync(
    [Buffer.from("token_authority")],
    program.programId
)[0];

export const solAccountPda = PublicKey.findProgramAddressSync(
    [Buffer.from("sol_account")],
    program.programId
)[0];

// State file path for persisting test state between test files
const STATE_FILE = path.join(__dirname, '.test-state.json');

// Function to save mint and user token account to a file
export function saveState(mint: PublicKey, userTokenAccount: PublicKey) {
    const state = {
        mint: mint.toString(),
        userTokenAccount: userTokenAccount.toString()
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    console.log("State saved:", state);
}

// Function to load mint and user token account from file
export function loadState(): { mint: PublicKey | null, userTokenAccount: PublicKey | null } {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
            const state = JSON.parse(data);
            return {
                mint: new PublicKey(state.mint),
                userTokenAccount: new PublicKey(state.userTokenAccount)
            };
        }
    } catch (error) {
        console.log("Error loading state:", error);
    }
    return { mint: null, userTokenAccount: null };
}

// Common setup function to fund accounts
export async function setupAccounts() {
    // Fund admin
    await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
            admin.publicKey,
            10 * LAMPORTS_PER_SOL
        )
    );

    // Fund user
    await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(
            user.publicKey,
            10 * LAMPORTS_PER_SOL
        )
    );

    console.log("Admin public key:", admin.publicKey.toString());
    console.log("User public key:", user.publicKey.toString());
    console.log("Timelock authority:", timelockAuthority.publicKey.toString());
    console.log("State PDA:", statePda.toString());
    console.log("Signer wallet address (Ethereum):", signerWallet.address);
} 