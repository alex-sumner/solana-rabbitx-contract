import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
  Transaction
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { BN } from "bn.js";
import * as crypto from "crypto";

import * as ethers from 'ethers';
import { signWithdrawal, getEthereumAddressBytes, generateEthereumAddress, waitForTimelock } from "./utils.ts";

/**
 * Helper to fetch and parse the State account directly
 */
async function fetchStateAccount(
  program: anchor.Program,
  statePda: PublicKey
): Promise<StateAccount> {
  const accountInfo = await program.provider.connection.getAccountInfo(statePda);
  if (!accountInfo) {
    throw new Error("State account not found");
  }

  return deserializeStateAccount(accountInfo.data);
}

/**
 * Interface for a TimelockOperation
 */
interface TimelockOperation {
  operationType: number;
  data: Buffer;
  queuedAt: number;
  canExecuteAt: number;
}

/**
 * Interface for State account data structure
 */
interface StateAccount {
  owner: PublicKey;
  withdrawalSigner: Buffer;
  nextDepositNum: any; // BN instance
  reentryLockStatus: number;
  tokenAccountBump: number;
  solAccountBump: number;
  supportedTokens: PublicKey[];
  minDeposits: Array<{ token: PublicKey, amount: any }>; // BN instance
  timelockAuthorities: PublicKey[];
  timelockDelay: any; // BN instance
  pendingOperations: TimelockOperation[];
  domainSeparator: Buffer | null;
}

/**
 * Deserialize the State account from its raw data
 */
function deserializeStateAccount(data: Buffer): StateAccount {
  // Skip the 8 byte discriminator
  const buffer = data.subarray(8);

  // Deserialize fields manually following the Rust struct definition
  let offset = 0;

  // owner: Pubkey (32 bytes)
  const owner = new PublicKey(buffer.subarray(offset, offset + 32));
  offset += 32;

  // withdrawal_signer: [u8; 20] (20 bytes)
  const withdrawalSigner = buffer.subarray(offset, offset + 20);
  offset += 20;

  // next_deposit_num: u64 (8 bytes)
  const nextDepositNum = new BN(buffer.subarray(offset, offset + 8), 'le');
  offset += 8;

  // reentry_lock_status: u8 (1 byte)
  const reentryLockStatus = buffer[offset];
  offset += 1;

  // token_account_bump: u8 (1 byte)
  const tokenAccountBump = buffer[offset];
  offset += 1;

  // sol_account_bump: u8 (1 byte)
  const solAccountBump = buffer[offset];
  offset += 1;

  // supportedTokens: Vec<Pubkey>
  const supportedTokensCount = buffer.readUInt32LE(offset);
  offset += 4;

  const supportedTokens: PublicKey[] = [];
  for (let i = 0; i < supportedTokensCount; i++) {
    supportedTokens.push(new PublicKey(buffer.subarray(offset, offset + 32)));
    offset += 32;
  }

  // min_deposits: Vec<(Pubkey, u64)>
  const minDepositsCount = buffer.readUInt32LE(offset);
  offset += 4;

  const minDeposits: Array<{ token: PublicKey, amount: any }> = [];
  for (let i = 0; i < minDepositsCount; i++) {
    const token = new PublicKey(buffer.subarray(offset, offset + 32));
    offset += 32;

    const amount = new BN(buffer.subarray(offset, offset + 8), 'le');
    offset += 8;

    minDeposits.push({ token, amount });
  }

  // timelock_authorities: Vec<Pubkey>
  const timelockAuthoritiesCount = buffer.readUInt32LE(offset);
  offset += 4;

  const timelockAuthorities: PublicKey[] = [];
  for (let i = 0; i < timelockAuthoritiesCount; i++) {
    timelockAuthorities.push(new PublicKey(buffer.subarray(offset, offset + 32)));
    offset += 32;
  }

  // timelock_delay: i64 (8 bytes)
  const timelockDelay = new BN(buffer.subarray(offset, offset + 8), 'le');
  offset += 8;

  // pending_operations: Vec<TimelockOperation>
  const pendingOperationsCount = buffer.readUInt32LE(offset);
  offset += 4;

  const pendingOperations: TimelockOperation[] = [];
  for (let i = 0; i < pendingOperationsCount; i++) {
    // operation_type: u8 (1 byte)
    const operationType = buffer[offset];
    offset += 1;

    // data: Vec<u8>
    const dataLength = buffer.readUInt32LE(offset);
    offset += 4;

    const data = buffer.subarray(offset, offset + dataLength);
    offset += dataLength;

    // queued_at: i64 (8 bytes)
    const queuedAt = new BN(buffer.subarray(offset, offset + 8), 'le').toNumber();
    offset += 8;

    // can_execute_at: i64 (8 bytes)
    const canExecuteAt = new BN(buffer.subarray(offset, offset + 8), 'le').toNumber();
    offset += 8;

    pendingOperations.push({
      operationType,
      data: Buffer.from(data),
      queuedAt,
      canExecuteAt
    });
  }

  // domain_separator: Option<[u8; 32]> (1 byte tag + 32 bytes if Some)
  const hasDomainSeparator = buffer[offset] === 1;
  offset += 1;

  let domainSeparator = null;
  if (hasDomainSeparator) {
    domainSeparator = buffer.subarray(offset, offset + 32);
    offset += 32;
  }

  return {
    owner,
    withdrawalSigner,
    nextDepositNum,
    reentryLockStatus,
    tokenAccountBump,
    solAccountBump,
    supportedTokens,
    minDeposits,
    timelockAuthorities,
    timelockDelay,
    pendingOperations,
    domainSeparator
  };
}

// The program ID comes from the IDL
const programId = new PublicKey("CZBh9LezU7rC2vpxCBs8w1TSFYmHDjU2WmWYkkcocq9W");

const opts = {
  preflightCommitment: "confirmed",
  commitment: "confirmed",
  skipPreflight: false,
};
// Use the same connection as the default provider
const connection = new anchor.web3.Connection(
  "http://localhost:8899",
  opts.commitment
);
const confirmOpts = {
  skipPreflight: opts.skipPreflight,
  commitment: opts.commitment,
  preflightCommitment: opts.preflightCommitment,
};
const wallet = anchor.Wallet.local();
const provider = new anchor.AnchorProvider(connection, wallet, confirmOpts);
anchor.setProvider(provider);

// Load the program
const program = anchor.workspace.Rbx;

// Test accounts
const admin = Keypair.generate();
const timelockAuthority = Keypair.generate();
const user = Keypair.generate();
let mint: PublicKey;
let userTokenAccount: PublicKey;

// Use a fixed private key for the signer in tests
// We'll use account #0 from Hardhat's default accounts
const signerWallet = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
console.log("Signer wallet address (Ethereum):", signerWallet.address);

// PDAs
const statePda = PublicKey.findProgramAddressSync(
  [Buffer.from("state")],
  program.programId
)[0];

async function getVerifyingContractFromProgram() {
  try {
    const hexString = await program.methods
      .getEip712VerifyingContract()
      .accounts({
        state: statePda,
      })
      .view();
    return hexString;
  } catch (e) {
    console.error("Error getting verifying contract:", e);
    return null;
  }
}

const tokenAuthPda = PublicKey.findProgramAddressSync(
  [Buffer.from("token_authority")],
  program.programId
)[0];

const solAccountPda = PublicKey.findProgramAddressSync(
  [Buffer.from("sol_account")],
  program.programId
)[0];

// Before all tests, fund accounts
before(async () => {
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
});

// SECTION 1: Basic setup tests
describe("basic setup", () => {
  it("Creates a token mint and user account", async () => {
    // Create a new token mint for testing
    mint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6 // 6 decimals
    );

    console.log("Token mint created:", mint.toString());

    // Create a token account for the user
    const { address } = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      mint,
      user.publicKey
    );

    userTokenAccount = address;
    console.log("User token account:", userTokenAccount.toString());

    // Mint tokens to user
    await mintTo(
      provider.connection,
      admin,
      mint,
      userTokenAccount,
      admin.publicKey,
      50_000_000 // 50 tokens
    );

    console.log("Minted 50 tokens to user");

    // Verify balance
    const userAccount = await provider.connection.getTokenAccountBalance(userTokenAccount);
    assert.equal(userAccount.value.uiAmount, 50);
  });

  it("Initializes the program with state PDA", async () => {
    console.log("Initializing program...");

    // Get the account info before initialization
    const stateAccountBefore = await provider.connection.getAccountInfo(statePda);
    console.log("State account exists before initialization:", !!stateAccountBefore);

    try {
      // Also support wrapped SOL
      const wrappedSolMint = new PublicKey("So11111111111111111111111111111111111111112");

      // Get the 20-byte Ethereum address from the wallet address
      const signerAddressBytes = getEthereumAddressBytes(signerWallet.address);
      console.log("Ethereum address bytes:", Buffer.from(signerAddressBytes).toString('hex'));

      // Call the initialize instruction
      const tx = await program.methods
        .initialize(
          mint,                           // Default token
          new BN(1_000_000),              // Min deposit
          new BN(5),                     // Timelock delay
          Array.from(signerAddressBytes), // 20-byte withdrawal signer as array
          [timelockAuthority.publicKey]   // array of timelock authority accounts
        )
        .accounts({
          state: statePda,
          owner: admin.publicKey,
          authority: timelockAuthority.publicKey,
          defaultTokenMint: mint,
          programTokenAuthority: tokenAuthPda,
          programSolAccount: solAccountPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin, timelockAuthority])
        .rpc();

      console.log("Program initialized! Transaction signature:", tx);

      console.log("withdrawal signer:", Buffer.from(signerAddressBytes).toString('hex'));

      // Check if the account was created
      const stateAccount = await provider.connection.getAccountInfo(statePda);
      assert.ok(stateAccount, "State account not found");
      assert.equal(stateAccount.owner.toString(), program.programId.toString(),
        "State account not owned by program");

      console.log("State account size:", stateAccount.data.length, "bytes");

      // Test our new view function
      const verifyingContractHex = await getVerifyingContractFromProgram();
      console.log("Verifying contract from program (hex):", verifyingContractHex);
      const expectedHex = `0x${Buffer.from(statePda.toBytes()).toString('hex')}`;
      assert.equal(verifyingContractHex.toLowerCase(), expectedHex.toLowerCase(),
        "Verifying contract from program doesn't match expected state PDA");
    } catch (e) {
      // Check if error is because account already exists
      if (e.message && e.message.includes("already in use")) {
        console.log("State account already initialized, continuing with tests");

        try {
          const verifyingContractHex = await getVerifyingContractFromProgram();
          console.log("Verifying contract from program (hex):", verifyingContractHex);
          const expectedHex = `0x${Buffer.from(statePda.toBytes()).toString('hex')}`;
          assert.equal(verifyingContractHex.toLowerCase(), expectedHex.toLowerCase(),
            "Verifying contract from program doesn't match expected state PDA");
        } catch (viewError) {
          console.error("Error getting verifying contract:", viewError);
        }
      } else {
        console.error("Error initializing program:", e);
        throw e;
      }
    }

    try {
      const stateAccount = await provider.connection.getAccountInfo(statePda);
      if (stateAccount) {
        console.log("State account exists and has data");
        console.log("State account owner:", stateAccount.owner.toString());
        console.log("Expected program ID:", program.programId.toString());
      }
    } catch (e) {
      console.log("Error accessing state account:", e.message);
    }

    // Now also support wrapped SOL
    try {
      const wrappedSolMint = new PublicKey("So11111111111111111111111111111111111111112");
      console.log("Supporting wrapped SOL for native deposits...");

      const tx = await program.methods
        .supportToken(new BN(1_000_000)) // 1 SOL min deposit
        .accounts({
          state: statePda,
          authority: timelockAuthority.publicKey,
          tokenMint: wrappedSolMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([timelockAuthority])
        .rpc();

      console.log("Added support for wrapped SOL! Transaction signature:", tx);
    } catch (e) {
      console.log("Error supporting wrapped SOL:", e);
    }
  });
});

// SECTION 2: Deposit and withdrawal tests
describe("deposit and withdrawal operations", () => {
  it("Deposits tokens", async () => {
    console.log("Testing token deposit...");

    // Get the program's token account address
    // This needs to follow the ATA derivation path
    const programTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin, // payer
      mint,
      tokenAuthPda,
      true // allowOwnerOffCurve
    ).then(account => account.address);

    console.log("Program token account:", programTokenAccount.toString());

    // Get initial balances
    const userTokenInfo = await provider.connection.getTokenAccountBalance(userTokenAccount);
    const initialUserBalance = parseInt(userTokenInfo.value.amount);
    console.log("Initial user token balance:", initialUserBalance / 10 ** 6);

    // Check if program token account exists
    let initialProgramBalance = 0;
    try {
      const programTokenInfo = await provider.connection.getTokenAccountBalance(programTokenAccount);
      initialProgramBalance = parseInt(programTokenInfo.value.amount);
      console.log("Initial program token balance:", initialProgramBalance / 10 ** 6);
    } catch (e) {
      console.log("Program token account doesn't exist yet or has no balance");
    }

    // Deposit amount
    const depositAmount = new BN(1_000_000); // 1 token

    try {
      // Call the deposit_token instruction
      const tx = await program.methods
        .depositToken(depositAmount)
        .accounts({
          state: statePda,
          mint: mint,
          programTokenAccount: programTokenAccount,
          programTokenAuthority: tokenAuthPda,
          userTokenAccount: userTokenAccount,
          user: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      console.log("Token deposit successful! Transaction signature:", tx);

      // Verify balances
      const finalUserTokenInfo = await provider.connection.getTokenAccountBalance(userTokenAccount);
      const finalUserBalance = parseInt(finalUserTokenInfo.value.amount);

      // Try to get program token balance
      let finalProgramBalance = 0;
      try {
        const programTokenInfo = await provider.connection.getTokenAccountBalance(programTokenAccount);
        finalProgramBalance = parseInt(programTokenInfo.value.amount);
      } catch (e) {
        console.error("Error getting program token balance:", e);
      }

      console.log("Final user token balance:", finalUserBalance / 10 ** 6);
      console.log("Final program token balance:", finalProgramBalance / 10 ** 6);

      // Calculate differences
      const userDiff = initialUserBalance - finalUserBalance;
      const programDiff = finalProgramBalance - initialProgramBalance;

      console.log("User balance decreased by:", userDiff / 10 ** 6);
      console.log("Program balance increased by:", programDiff / 10 ** 6);

      // Verify the deposit worked correctly
      assert.equal(userDiff, depositAmount.toNumber(),
        "User token decrease doesn't match deposit amount");
      assert.equal(programDiff, depositAmount.toNumber(),
        "Program token increase doesn't match deposit amount");

    } catch (e) {
      console.error("Error during token deposit:", e);
      throw e;
    }
  });

  it("Deposits native SOL", async () => {
    console.log("Testing native SOL deposit...");

    // Get initial balances
    const initialUserSol = await provider.connection.getBalance(user.publicKey);
    const initialProgramSol = await provider.connection.getBalance(solAccountPda);

    console.log("Initial user SOL balance:", initialUserSol / LAMPORTS_PER_SOL, "SOL");
    console.log("Initial program SOL balance:", initialProgramSol / LAMPORTS_PER_SOL, "SOL");

    // Deposit amount
    const solDepositAmount = new BN(2 * LAMPORTS_PER_SOL); // 2 SOL

    try {
      // Wrapped SOL mint
      const wrappedSolMint = new PublicKey("So11111111111111111111111111111111111111112");

      // Call the deposit_native instruction
      const tx = await program.methods
        .depositNative(solDepositAmount)
        .accounts({
          state: statePda,
          wrappedSolMint: wrappedSolMint,
          programSolAccount: solAccountPda,
          user: user.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      console.log("SOL deposit successful! Transaction signature:", tx);

      // Verify balances
      const finalUserSol = await provider.connection.getBalance(user.publicKey);
      const finalProgramSol = await provider.connection.getBalance(solAccountPda);

      console.log("Final user SOL balance:", finalUserSol / LAMPORTS_PER_SOL, "SOL");
      console.log("Final program SOL balance:", finalProgramSol / LAMPORTS_PER_SOL, "SOL");

      // Calculate differences
      const userSolDiff = initialUserSol - finalUserSol;
      const programSolDiff = finalProgramSol - initialProgramSol;

      console.log("User SOL decreased by:", userSolDiff / LAMPORTS_PER_SOL, "SOL");
      console.log("Program SOL increased by:", programSolDiff / LAMPORTS_PER_SOL, "SOL");

      // Verify the deposit worked correctly
      // User pays transaction fees so the decrease will be more than the deposit amount
      assert.isAtLeast(userSolDiff, solDepositAmount.toNumber(),
        "User SOL decrease is less than deposit amount");
      assert.equal(programSolDiff, solDepositAmount.toNumber(),
        "Program SOL increase doesn't match deposit amount");

    } catch (e) {
      console.error("Error during SOL deposit:", e);
      throw e;
    }
  });

  // Try withdrawal with fixed chain ID in Rust
  it("Withdraws tokens with signed EIP712 message", async () => {
    console.log("Testing token withdrawal...");

    // Get the program's token account address
    const programTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin, // payer
      mint,
      tokenAuthPda,
      true // allowOwnerOffCurve
    ).then(account => account.address);

    // Get initial balances
    const userTokenInfo = await provider.connection.getTokenAccountBalance(userTokenAccount);
    const initialUserBalance = parseInt(userTokenInfo.value.amount);

    // Check program token balance
    let initialProgramBalance = 0;
    try {
      const programTokenInfo = await provider.connection.getTokenAccountBalance(programTokenAccount);
      initialProgramBalance = parseInt(programTokenInfo.value.amount);
    } catch (e) {
      console.log("Program token account doesn't exist yet or has no balance");
    }

    console.log("Initial user token balance:", initialUserBalance / 10 ** 6);
    console.log("Initial program token balance:", initialProgramBalance / 10 ** 6);

    // Create withdrawal data
    const withdrawalId = 12345; // Unique ID for this withdrawal
    const withdrawalAmount = new BN(500_000); // 0.5 tokens

    // Get the 20-byte Ethereum address that should be stored in the state
    const ethAddressBytes = getEthereumAddressBytes(signerWallet.address);
    console.log("Using Ethereum address bytes:", Buffer.from(ethAddressBytes).toString('hex'));

    // Use the program's state PDA as the verifying contract
    // No need to convert to Ethereum address format
    console.log("statePda:", statePda);

    // Use the native Solana PublicKeys directly
    console.log("Token (Solana):", mint.toString());
    console.log("Trader (Solana):", user.publicKey.toString());

    // Create the withdrawal data with native Solana PublicKeys
    const withdrawalData = {
      id: withdrawalId,
      token: mint,
      trader: user.publicKey,
      amount: withdrawalAmount.toString(),
    };

    console.log("Withdrawal data:", withdrawalData);
    console.log("Verifying contract (Solana):", statePda.toString());

    // Sign the withdrawal with the Ethereum wallet - using Solana native pubkeys
    const { v, r, s } = await signWithdrawal(
      signerWallet,
      statePda,  // Use the Solana pubkey directly
      withdrawalData
    );

    console.log("Signature components:", { v, r: Buffer.from(r).toString('hex'), s: Buffer.from(s).toString('hex') });

    // Find the withdrawal record account PDA
    const withdrawalAccount = PublicKey.findProgramAddressSync(
      [
        Buffer.from("withdrawal_account"),
        new BN(withdrawalId / 4000).toArrayLike(Buffer, 'le', 8)
      ],
      program.programId
    )[0];

    console.log("Withdrawal account PDA:", withdrawalAccount.toString());

    try {
      // Prepare the withdraw instruction
      const withdrawIx = await program.methods
        .withdrawToken(
          new BN(withdrawalId),
          withdrawalAmount,
          v,
          r,
          s
        )
        .accounts({
          state: statePda,
          withdrawalRecord: withdrawalAccount,
          mint: mint,
          programTokenAccount: programTokenAccount,
          programTokenAuthority: tokenAuthPda,
          traderTokenAccount: userTokenAccount,
          trader: user.publicKey,
          payer: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction();

      // Create transaction with our withdraw instruction
      const transaction = new anchor.web3.Transaction()
        .add(withdrawIx);

      // Execute the transaction directly
      let tx;
      try {
        /* Simulation code - uncomment for debugging
        // First attempt simulation to get detailed logs
        // We need to set the fee payer explicitly for simulation
        transaction.feePayer = user.publicKey;
        transaction.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
        
        const sim = await provider.connection.simulateTransaction(transaction);
        if (sim.value.err) {
          console.log("Simulation logs for token withdrawal:", sim.value.logs);
        } else {
          console.log("Simulation successful, logs:", sim.value.logs);
        }
        */

        // Execute the transaction
        tx = await anchor.web3.sendAndConfirmTransaction(
          provider.connection,
          transaction,
          [user],
          {
            //skipPreflight: true, // Uncomment to skip pre-flight simulation and get full logs
            commitment: 'confirmed'
          }
        );
        console.log("Token withdrawal successful! Transaction signature:", tx);
      } catch (error) {
        if (error.logs) {
          console.log("Detailed token withdrawal error logs:", error.logs);
        }
        throw error;
      }

      // Verify balances
      const finalUserTokenInfo = await provider.connection.getTokenAccountBalance(userTokenAccount);
      const finalUserBalance = parseInt(finalUserTokenInfo.value.amount);

      const finalProgramTokenInfo = await provider.connection.getTokenAccountBalance(programTokenAccount);
      const finalProgramBalance = parseInt(finalProgramTokenInfo.value.amount);

      console.log("Final user token balance:", finalUserBalance / 10 ** 6);
      console.log("Final program token balance:", finalProgramBalance / 10 ** 6);

      // Calculate differences
      const userDiff = finalUserBalance - initialUserBalance;
      const programDiff = initialProgramBalance - finalProgramBalance;

      console.log("User balance increased by:", userDiff / 10 ** 6);
      console.log("Program balance decreased by:", programDiff / 10 ** 6);

      // Verify the withdrawal worked correctly
      assert.equal(userDiff, withdrawalAmount.toNumber(),
        "User token increase doesn't match withdrawal amount");
      assert.equal(programDiff, withdrawalAmount.toNumber(),
        "Program token decrease doesn't match withdrawal amount");

    } catch (e) {
      console.error("Error during token withdrawal:", e);
      throw e;
    }
  });

  // Using test mode in Rust to accept signatures
  it("Withdraws native SOL with signed EIP712 message", async () => {
    console.log("Testing native SOL withdrawal...");

    // Get initial balances
    const initialUserSol = await provider.connection.getBalance(user.publicKey);
    const initialProgramSol = await provider.connection.getBalance(solAccountPda);

    console.log("Initial user SOL balance:", initialUserSol / LAMPORTS_PER_SOL, "SOL");
    console.log("Initial program SOL balance:", initialProgramSol / LAMPORTS_PER_SOL, "SOL");

    // Create withdrawal data
    const withdrawalId = 54321; // Different ID for this withdrawal
    const withdrawalAmount = new BN(1 * LAMPORTS_PER_SOL); // 1 SOL

    // Wrapped SOL mint address
    const wrappedSolMint = new PublicKey("So11111111111111111111111111111111111111112");

    // Get the 20-byte Ethereum address that should be stored in the state
    const ethAddressBytes = getEthereumAddressBytes(signerWallet.address);
    console.log("Using Ethereum address bytes:", Buffer.from(ethAddressBytes).toString('hex'));

    // Use the program's state PDA as the verifying contract directly

    // Use the native Solana PublicKeys directly
    console.log("Wrapped SOL (Solana):", wrappedSolMint.toString());
    console.log("Trader (Solana):", user.publicKey.toString());

    // Create the withdrawal data with native Solana PublicKeys
    const withdrawalData = {
      id: withdrawalId,
      token: wrappedSolMint,
      trader: user.publicKey,
      amount: withdrawalAmount.toString(),
    };

    console.log("SOL Withdrawal data:", withdrawalData);
    console.log("Verifying contract (Solana):", statePda.toString());

    // Sign the withdrawal with the Ethereum wallet - using Solana native pubkeys
    const { v, r, s } = await signWithdrawal(
      signerWallet,
      statePda,  // Use the Solana pubkey directly
      withdrawalData
    );

    // Find the withdrawal record account PDA
    const withdrawalAccount = PublicKey.findProgramAddressSync(
      [
        Buffer.from("withdrawal_account"),
        new BN(withdrawalId / 4000).toArrayLike(Buffer, 'le', 8)
      ],
      program.programId
    )[0];

    // We now use "sol_account" seed consistently for both deposits and withdrawals
    const nativeSolAccountPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_account")],
      program.programId
    )[0];

    console.log("Sol account PDA for withdrawal:", nativeSolAccountPDA.toString());

    try {
      // Instead of creating an instruction and transaction, use the direct .rpc() approach
      const tx = await program.methods
        .withdrawNative(
          new BN(withdrawalId),
          withdrawalAmount,
          v,
          r,
          s
        )
        .accounts({
          state: statePda,
          withdrawalRecord: withdrawalAccount,
          wrappedSolMint: wrappedSolMint,
          programSolAccount: nativeSolAccountPDA,
          trader: user.publicKey, // The trader/recipient doesn't sign
          payer: user.publicKey, // User is the signer/payer
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([user])
        .rpc();

      console.log("SOL withdrawal successful! Transaction signature:", tx);

      // Verify balances
      const finalUserSol = await provider.connection.getBalance(user.publicKey);
      const finalProgramSol = await provider.connection.getBalance(nativeSolAccountPDA);

      console.log("Final user SOL balance:", finalUserSol / LAMPORTS_PER_SOL, "SOL");
      console.log("Final program SOL balance:", finalProgramSol / LAMPORTS_PER_SOL, "SOL");

      // Calculate differences
      const userSolDiff = finalUserSol - initialUserSol;
      const programSolDiff = initialProgramSol - finalProgramSol;

      console.log("User SOL increased by:", userSolDiff / LAMPORTS_PER_SOL, "SOL");
      console.log("Program SOL decreased by:", programSolDiff / LAMPORTS_PER_SOL, "SOL");

      // Verify the withdrawal worked
      // The increase in user's SOL will be less than the withdrawal amount due to transaction fees
      assert.isAtLeast(
        userSolDiff,
        0,
        "User SOL should increase after withdrawal"
      );
      // But the program should have sent the full amount
      assert.equal(
        programSolDiff,
        withdrawalAmount.toNumber(),
        "Program SOL decrease doesn't match withdrawal amount"
      );

    } catch (e) {
      console.error("Error during SOL withdrawal:", e);
      throw e;
    }
  });

  it("Gets the EIP-712 verifying contract address", async () => {
    console.log("\nTesting get_eip712_verifying_contract function...");

    try {
      // Call the function to get the verifying contract address as hex string
      const verifyingContractHex = await getVerifyingContractFromProgram();

      // Log the hex string
      console.log("EIP-712 Verifying Contract Address (hex):", verifyingContractHex);

      // Verify it's a valid hex string
      assert.ok(verifyingContractHex.startsWith('0x'), "Returned value doesn't start with 0x");
      assert.equal(verifyingContractHex.length, 66, "Hex string should be 66 characters (0x + 64 chars for 32 bytes)");

      // Convert the expected state PDA to a hex string for comparison
      const expectedHex = `0x${Buffer.from(statePda.toBytes()).toString('hex')}`;

      // Verify it matches our derived state PDA (converted to hex)
      assert.equal(verifyingContractHex.toLowerCase(), expectedHex.toLowerCase(),
        "Verifying contract hex doesn't match the expected state PDA");

      // For reference, also show the program ID
      console.log("Program ID:", program.programId.toString());

      // Show how this would be used directly in EIP-712 signing
      console.log("Ready to use for EIP-712 domain separator calculation");

      return verifyingContractHex;
    } catch (e) {
      console.error("Error getting EIP-712 verifying contract:", e);
      throw e;
    }
  });

  it("Fails on duplicate withdrawal attempt with same ID", async () => {
    console.log("Testing duplicate token withdrawal prevention...");

    // Get the program's token account address
    const programTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin, // payer
      mint,
      tokenAuthPda,
      true // allowOwnerOffCurve
    ).then(account => account.address);

    // Get initial balances before first withdrawal
    const userTokenInfo = await provider.connection.getTokenAccountBalance(userTokenAccount);
    const initialUserBalance = parseInt(userTokenInfo.value.amount);
    let initialProgramBalance = 0;

    try {
      const programTokenInfo = await provider.connection.getTokenAccountBalance(programTokenAccount);
      initialProgramBalance = parseInt(programTokenInfo.value.amount);
    } catch (e) {
      console.log("Program token account doesn't exist yet or has no balance");
    }

    console.log("Initial user token balance:", initialUserBalance / 10 ** 6);
    console.log("Initial program token balance:", initialProgramBalance / 10 ** 6);

    // Create withdrawal data with a UNIQUE ID that hasn't been used before
    const duplicateWithdrawalId = 78910; // Unique ID for this test
    const withdrawalAmount = new BN(300_000); // 0.3 tokens

    // Get the 20-byte Ethereum address that should be stored in the state
    const ethAddressBytes = getEthereumAddressBytes(signerWallet.address);
    console.log("Using Ethereum address bytes:", Buffer.from(ethAddressBytes).toString('hex'));

    // Create the withdrawal data with native Solana PublicKeys
    const withdrawalData = {
      id: duplicateWithdrawalId,
      token: mint,
      trader: user.publicKey,
      amount: withdrawalAmount.toString(),
    };

    console.log("Withdrawal data:", withdrawalData);

    // Sign the withdrawal with the Ethereum wallet
    const { v, r, s } = await signWithdrawal(
      signerWallet,
      statePda,
      withdrawalData
    );

    // Find the withdrawal record account PDA
    const withdrawalAccount = PublicKey.findProgramAddressSync(
      [
        Buffer.from("withdrawal_account"),
        new BN(duplicateWithdrawalId / 4000).toArrayLike(Buffer, 'le', 8)
      ],
      program.programId
    )[0];

    console.log("Withdrawal account PDA:", withdrawalAccount.toString());

    // FIRST WITHDRAWAL - This should succeed
    try {
      console.log("\nAttempting first withdrawal with ID:", duplicateWithdrawalId);

      // Prepare the withdraw instruction
      const withdrawIx = await program.methods
        .withdrawToken(
          new BN(duplicateWithdrawalId),
          withdrawalAmount,
          v,
          r,
          s
        )
        .accounts({
          state: statePda,
          withdrawalRecord: withdrawalAccount,
          mint: mint,
          programTokenAccount: programTokenAccount,
          programTokenAuthority: tokenAuthPda,
          traderTokenAccount: userTokenAccount,
          trader: user.publicKey,
          payer: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction();

      // Create transaction with our withdraw instruction
      const transaction = new anchor.web3.Transaction()
        .add(withdrawIx);

      // Execute the transaction
      const tx = await anchor.web3.sendAndConfirmTransaction(
        provider.connection,
        transaction,
        [user],
        { commitment: 'confirmed' }
      );

      console.log("First withdrawal successful! Transaction signature:", tx);

      // Verify first withdrawal succeeded by checking balances
      const afterFirstWithdrawUserBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(userTokenAccount)).value.amount
      );

      // Calculate balance change
      const userBalanceChange = afterFirstWithdrawUserBalance - initialUserBalance;
      console.log("User token balance increased by:", userBalanceChange / 10 ** 6);
      assert.equal(userBalanceChange, withdrawalAmount.toNumber(),
        "First withdrawal didn't transfer the expected amount");

      // SECOND WITHDRAWAL - This should fail with WithdrawalAlreadyProcessed
      console.log("\nAttempting second withdrawal with SAME ID:", duplicateWithdrawalId);
      console.log("(This should fail with WithdrawalAlreadyProcessed error)");

      // Prepare the second withdraw instruction with SAME ID
      const duplicateWithdrawIx = await program.methods
        .withdrawToken(
          new BN(duplicateWithdrawalId), // Same ID
          withdrawalAmount,
          v,
          r,
          s
        )
        .accounts({
          state: statePda,
          withdrawalRecord: withdrawalAccount,
          mint: mint,
          programTokenAccount: programTokenAccount,
          programTokenAuthority: tokenAuthPda,
          traderTokenAccount: userTokenAccount,
          trader: user.publicKey,
          payer: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction();

      // Create transaction for second attempt
      const duplicateTransaction = new anchor.web3.Transaction()
        .add(duplicateWithdrawIx);

      // This should throw an error - attempt to process duplicate withdrawal
      try {
        await anchor.web3.sendAndConfirmTransaction(
          provider.connection,
          duplicateTransaction,
          [user],
          { commitment: 'confirmed' }
        );

        // If we get here, the test failed because the duplicate withdrawal succeeded
        assert.fail("Second withdrawal with same ID should have failed but succeeded");
      } catch (error) {
        // Check if the error contains the expected message
        console.log("Second withdrawal failed as expected with error:");
        if (error.logs) {
          const errorLogs = error.logs.join('\n');
          console.log(errorLogs);

          // Check for WithdrawalAlreadyProcessed in the error logs
          assert.ok(
            errorLogs.includes("WithdrawalAlreadyProcessed") ||
            errorLogs.includes("Already processed"),
            "Error should contain WithdrawalAlreadyProcessed message"
          );
          console.log("✅ Test passed: Second withdrawal correctly failed with WithdrawalAlreadyProcessed error");
        } else {
          console.log(error.message);
          // If logs aren't available, just check for a general error
          assert.ok(error, "Second withdrawal should have failed");
        }
      }

      // Verify balances didn't change after failed second withdrawal attempt
      const finalUserBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(userTokenAccount)).value.amount
      );

      assert.equal(finalUserBalance, afterFirstWithdrawUserBalance,
        "User balance should not change after failed withdrawal attempt");

    } catch (e) {
      console.error("Error during duplicate withdrawal test:", e);
      throw e;
    }
  });

  it("Allows a different account to sign for a trader's withdrawal", async () => {
    console.log("Testing withdrawal with different signer than recipient...");

    // Get the program's token account address
    const programTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin, // payer
      mint,
      tokenAuthPda,
      true // allowOwnerOffCurve
    ).then(account => account.address);

    // Create a recipient (who will NOT sign the transaction)
    const recipient = Keypair.generate();
    console.log("Recipient (non-signer) created:", recipient.publicKey.toString());

    // Fund recipient to create token account
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        recipient.publicKey,
        0.1 * LAMPORTS_PER_SOL
      )
    );

    // Create recipient token account
    const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      mint,
      recipient.publicKey
    ).then(account => account.address);
    console.log("Recipient token account:", recipientTokenAccount.toString());

    // Ensure program has enough tokens by depositing more if needed
    console.log("Ensuring program has enough tokens for proxy withdrawal test...");
    try {
      // Check program token balance
      const programTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint,
        tokenAuthPda,
        true // allowOwnerOffCurve
      ).then(account => account.address);

      const programBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(programTokenAccount)).value.amount
      );

      if (programBalance < 500000) { // If less than 0.5 tokens
        console.log("Program token balance is low, depositing more tokens...");
        // Mint more tokens to user
        await mintTo(
          provider.connection,
          admin,
          mint,
          userTokenAccount,
          admin.publicKey,
          2_000_000 // 2 more tokens
        );

        // Deposit tokens
        const depositTx = await program.methods
          .depositToken(new BN(1_000_000)) // Deposit 1 token
          .accounts({
            state: statePda,
            mint: mint,
            programTokenAccount: programTokenAccount,
            programTokenAuthority: tokenAuthPda,
            userTokenAccount: userTokenAccount,
            user: user.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        console.log("Deposited more tokens to program:", depositTx);
      }
    } catch (e) {
      console.error("Error ensuring program has tokens:", e);
    }

    // Get initial balances
    const initialRecipientBalance = parseInt(
      (await provider.connection.getTokenAccountBalance(recipientTokenAccount)).value.amount
    );
    console.log("Initial recipient token balance:", initialRecipientBalance / 10 ** 6);

    // Create withdrawal data - note that trader is recipient, but user will sign
    const proxyWithdrawalId = 44444;
    const withdrawalAmount = new BN(400_000); // 0.4 tokens

    const withdrawalData = {
      id: proxyWithdrawalId,
      token: mint,
      trader: recipient.publicKey, // Recipient is the trader in the signature
      amount: withdrawalAmount.toString(),
    };

    // Sign the withdrawal with the Ethereum wallet
    // This authorizes funds to go to recipient
    const { v, r, s } = await signWithdrawal(
      signerWallet,
      statePda,
      withdrawalData
    );

    // Find the withdrawal record account PDA
    const withdrawalAccount = PublicKey.findProgramAddressSync(
      [
        Buffer.from("withdrawal_account"),
        new BN(proxyWithdrawalId / 4000).toArrayLike(Buffer, 'le', 8)
      ],
      program.programId
    )[0];

    try {
      console.log("\nAttempting withdrawal where user signs on behalf of recipient");
      console.log("Signer:", user.publicKey.toString());
      console.log("Recipient:", recipient.publicKey.toString());

      // Prepare the withdraw instruction
      const withdrawIx = await program.methods
        .withdrawToken(
          new BN(proxyWithdrawalId),
          withdrawalAmount,
          v,
          r,
          s
        )
        .accounts({
          state: statePda,
          withdrawalRecord: withdrawalAccount,
          mint: mint,
          programTokenAccount: programTokenAccount,
          programTokenAuthority: tokenAuthPda,
          traderTokenAccount: recipientTokenAccount,
          trader: recipient.publicKey, // The trader/recipient doesn't sign
          payer: user.publicKey, // User is the signer/payer
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction();

      // Create transaction with our withdraw instruction
      const transaction = new anchor.web3.Transaction()
        .add(withdrawIx);

      // Execute the transaction - only user signs, not recipient
      const tx = await anchor.web3.sendAndConfirmTransaction(
        provider.connection,
        transaction,
        [user], // Only user signs, not recipient
        { commitment: 'confirmed' }
      );

      console.log("Proxy withdrawal successful! Transaction signature:", tx);

      // Verify funds were sent to recipient
      const finalRecipientBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(recipientTokenAccount)).value.amount
      );
      console.log("Final recipient token balance:", finalRecipientBalance / 10 ** 6);

      // Calculate balance change
      const recipientBalanceChange = finalRecipientBalance - initialRecipientBalance;
      console.log("Recipient token balance increased by:", recipientBalanceChange / 10 ** 6);

      // Verify the withdrawal worked correctly
      assert.equal(recipientBalanceChange, withdrawalAmount.toNumber(),
        "Recipient token increase doesn't match withdrawal amount");

      console.log("✅ Test passed: Token withdrawal succeeded with different signer than recipient");
    } catch (e) {
      console.error("Error during proxy token withdrawal test:", e);
      if (e.logs) {
        console.log("Detailed error logs:", e.logs);
      }
      throw e;
    }
  });

  it("Allows a different account to sign for a trader's SOL withdrawal", async () => {
    console.log("Testing SOL withdrawal with different signer than recipient...");

    // Create a recipient (who will NOT sign the transaction)
    const recipient = Keypair.generate();
    console.log("SOL Recipient (non-signer) created:", recipient.publicKey.toString());

    // Get initial balances
    const initialRecipientBalance = await provider.connection.getBalance(recipient.publicKey);
    console.log("Initial recipient SOL balance:", initialRecipientBalance / LAMPORTS_PER_SOL, "SOL");

    // Wrapped SOL mint address
    const wrappedSolMint = new PublicKey("So11111111111111111111111111111111111111112");

    // Create withdrawal data - note that trader is recipient, but user will sign
    const proxyWithdrawalId = 55555;
    const withdrawalAmount = new BN(0.5 * LAMPORTS_PER_SOL); // 0.5 SOL

    const withdrawalData = {
      id: proxyWithdrawalId,
      token: wrappedSolMint,
      trader: recipient.publicKey, // Recipient is the trader in the signature
      amount: withdrawalAmount.toString(),
    };

    // Sign the withdrawal with the Ethereum wallet
    // This authorizes funds to go to recipient
    const { v, r, s } = await signWithdrawal(
      signerWallet,
      statePda,
      withdrawalData
    );

    // Find the withdrawal record account PDA
    const withdrawalAccount = PublicKey.findProgramAddressSync(
      [
        Buffer.from("withdrawal_account"),
        new BN(proxyWithdrawalId / 4000).toArrayLike(Buffer, 'le', 8)
      ],
      program.programId
    )[0];

    // We now use "sol_account" seed consistently for both deposits and withdrawals
    const nativeSolAccountPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_account")],
      program.programId
    )[0];

    try {
      console.log("\nAttempting SOL withdrawal where user signs on behalf of recipient");
      console.log("Signer:", user.publicKey.toString());
      console.log("Recipient:", recipient.publicKey.toString());

      // Use the direct .rpc() approach
      const tx = await program.methods
        .withdrawNative(
          new BN(proxyWithdrawalId),
          withdrawalAmount,
          v,
          r,
          s
        )
        .accounts({
          state: statePda,
          withdrawalRecord: withdrawalAccount,
          wrappedSolMint: wrappedSolMint,
          programSolAccount: nativeSolAccountPDA,
          trader: recipient.publicKey, // The trader/recipient doesn't sign
          payer: user.publicKey, // User is the signer/payer
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([user]) // Only user signs, not recipient
        .rpc();

      console.log("Proxy SOL withdrawal successful! Transaction signature:", tx);

      // Verify funds were sent to recipient
      const finalRecipientBalance = await provider.connection.getBalance(recipient.publicKey);
      console.log("Final recipient SOL balance:", finalRecipientBalance / LAMPORTS_PER_SOL, "SOL");

      // Calculate balance change
      const recipientBalanceChange = finalRecipientBalance - initialRecipientBalance;
      console.log("Recipient SOL balance increased by:", recipientBalanceChange / LAMPORTS_PER_SOL, "SOL");

      // Verify the withdrawal worked correctly
      assert.equal(recipientBalanceChange, withdrawalAmount.toNumber(),
        "Recipient SOL increase doesn't match withdrawal amount");

      console.log("✅ Test passed: SOL withdrawal succeeded with different signer than recipient");
    } catch (e) {
      console.error("Error during SOL withdrawal:", e);
      throw e;
    }
  });

  it("Fails when using valid signatures with modified withdrawal data", async () => {
    console.log("Testing signature specificity for withdrawal parameters...");

    // Get the program's token account address
    const programTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin, // payer
      mint,
      tokenAuthPda,
      true // allowOwnerOffCurve
    ).then(account => account.address);

    // Create another token for testing token address modification
    const altMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6 // 6 decimals
    );
    console.log("Alternative token mint created:", altMint.toString());

    // Create a token account for the alternative token
    const altTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      altMint,
      user.publicKey
    ).then(account => account.address);

    const altProgramTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin, // payer
      altMint,
      tokenAuthPda,
      true // allowOwnerOffCurve
    ).then(account => account.address);

    // Mint tokens to program account to support withdrawals
    await mintTo(
      provider.connection,
      admin,
      altMint,
      altProgramTokenAccount,
      admin.publicKey,
      10_000_000 // 10 alt tokens to program
    );

    // Create another user for testing trader address modification
    const altUser = Keypair.generate();

    // Fund alt user
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        altUser.publicKey,
        2 * LAMPORTS_PER_SOL
      )
    );
    console.log("Alternative user created:", altUser.publicKey.toString());

    // Create token accounts for the alt user
    const altUserTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      mint,
      altUser.publicKey
    ).then(account => account.address);

    // ORIGINAL WITHDRAWAL DATA (we'll get a signature for this)
    const originalId = 99100;
    const originalAmount = new BN(200_000); // 0.2 tokens

    const originalWithdrawalData = {
      id: originalId,
      token: mint,
      trader: user.publicKey,
      amount: originalAmount.toString(),
    };

    console.log("\nOriginal withdrawal data for signature:");
    console.log("ID:", originalId);
    console.log("Token:", mint.toString());
    console.log("Trader:", user.publicKey.toString());
    console.log("Amount:", originalAmount.toString());

    // Get signature for the ORIGINAL data
    const { v, r, s } = await signWithdrawal(
      signerWallet,
      statePda,
      originalWithdrawalData
    );

    console.log("Obtained signature for original withdrawal data");
    console.log("v:", v);
    console.log("r:", Buffer.from(r).toString('hex'));
    console.log("s:", Buffer.from(s).toString('hex'));

    // Find the original withdrawal record account PDA
    const originalWithdrawalAccount = PublicKey.findProgramAddressSync(
      [
        Buffer.from("withdrawal_account"),
        new BN(originalId / 4000).toArrayLike(Buffer, 'le', 8)
      ],
      program.programId
    )[0];

    // Helper function to attempt withdrawal and verify it fails with invalid signature
    async function attemptInvalidWithdrawal(
      testName: string,
      withdrawalId: number,
      withdrawalToken: PublicKey,
      withdrawalTrader: PublicKey,
      withdrawalAmount: BN,
      tokenAccount: PublicKey
    ) {
      console.log(`\nTEST ${testName}`);
      console.log("ID:", withdrawalId);
      console.log("Token:", withdrawalToken.toString());
      console.log("Trader:", withdrawalTrader.toString());
      console.log("Amount:", withdrawalAmount.toString());

      // Find the appropriate withdrawal record PDA for this ID
      const withdrawalAccount = PublicKey.findProgramAddressSync(
        [
          Buffer.from("withdrawal_account"),
          new BN(withdrawalId / 4000).toArrayLike(Buffer, 'le', 8)
        ],
        program.programId
      )[0];

      // Prepare the appropriate token accounts
      const programAccount = withdrawalToken.equals(mint)
        ? programTokenAccount
        : altProgramTokenAccount;

      // Prepare the withdraw instruction with the ORIGINAL signature
      // but MODIFIED data
      const withdrawIx = await program.methods
        .withdrawToken(
          new BN(withdrawalId),
          withdrawalAmount,
          v, // Original signature
          r, // Original signature
          s  // Original signature
        )
        .accounts({
          state: statePda,
          withdrawalRecord: withdrawalAccount,
          mint: withdrawalToken,
          programTokenAccount: programAccount,
          programTokenAuthority: tokenAuthPda,
          traderTokenAccount: tokenAccount,
          trader: withdrawalTrader,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction();

      // Create transaction with our withdraw instruction
      const transaction = new anchor.web3.Transaction()
        .add(withdrawIx);

      // This should throw an error due to invalid signature
      try {
        await anchor.web3.sendAndConfirmTransaction(
          provider.connection,
          transaction,
          [withdrawalTrader === user.publicKey ? user : altUser],
          { commitment: 'confirmed' }
        );

        // If we get here, the test failed because the withdrawal succeeded with modified data
        assert.fail(`Withdrawal with modified ${testName} should have failed but succeeded`);
      } catch (error) {
        // Check if the error contains the expected message
        console.log(`Withdrawal with modified ${testName} failed as expected with error:`);
        if (error.logs) {
          const errorLogs = error.logs.join('\n');

          // Log the first few lines of the error for debugging
          console.log(errorLogs.split('\n').slice(0, 5).join('\n') + '...');

          // Check for InvalidSignature in the error logs
          assert.ok(
            errorLogs.includes("InvalidSignature") ||
            errorLogs.includes("invalid signature") ||
            errorLogs.includes("signature verification failed"),
            `Error for ${testName} should indicate invalid signature`
          );
          console.log(`✅ Test passed: Withdrawal with modified ${testName} correctly failed with signature verification error`);
        } else {
          console.log(error.message);
          // If logs aren't available, just check for a general error
          assert.ok(error, `Withdrawal with modified ${testName} should have failed`);
        }
      }
    }

    // Test 1: Different withdrawal ID
    await attemptInvalidWithdrawal(
      "Withdrawal ID",
      originalId + 1, // Different ID
      mint,           // Same token
      user.publicKey, // Same trader
      originalAmount, // Same amount
      userTokenAccount
    );

    // Test 2: Different trader address
    await attemptInvalidWithdrawal(
      "Trader Address",
      originalId,        // Same ID
      mint,              // Same token
      altUser.publicKey, // Different trader
      originalAmount,    // Same amount
      altUserTokenAccount
    );

    // Test 3: Different token address
    await attemptInvalidWithdrawal(
      "Token Address",
      originalId,     // Same ID
      altMint,        // Different token
      user.publicKey, // Same trader
      originalAmount, // Same amount
      altTokenAccount
    );

    // Test 4: Different amount
    await attemptInvalidWithdrawal(
      "Amount",
      originalId,                 // Same ID
      mint,                       // Same token
      user.publicKey,             // Same trader
      originalAmount.addn(10000), // Different amount
      userTokenAccount
    );

    console.log("\n✅ All signature specificity tests passed!");
    console.log("The program correctly rejected all attempts to use a valid signature with modified withdrawal parameters.");
  });

  it("Performs multiple withdrawals across separate transactions", async () => {
    console.log("\n=== Testing multiple withdrawals in sequence ===");

    // Create a dedicated recipient for this test
    const recipient = Keypair.generate();
    console.log("Multi-withdrawal recipient created:", recipient.publicKey.toString());

    // Fund recipient to cover account creation costs
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        recipient.publicKey,
        0.2 * LAMPORTS_PER_SOL
      )
    );

    // Create recipient token account
    const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      mint,
      recipient.publicKey
    ).then(account => account.address);
    console.log("Recipient token account:", recipientTokenAccount.toString());

    // Get program token account
    const programTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      mint,
      tokenAuthPda,
      true // allowOwnerOffCurve
    ).then(account => account.address);

    // Ensure program has sufficient tokens for all withdrawals
    console.log("Ensuring program has enough tokens for multiple withdrawals...");
    const programBalance = parseInt(
      (await provider.connection.getTokenAccountBalance(programTokenAccount)).value.amount
    );

    if (programBalance < 3_000_000) { // Need at least 3 tokens
      console.log("Program token balance too low, depositing more tokens...");

      // Mint more tokens to user
      await mintTo(
        provider.connection,
        admin,
        mint,
        userTokenAccount,
        admin.publicKey,
        5_000_000 // 5 more tokens
      );

      // Deposit tokens to program
      const depositTx = await program.methods
        .depositToken(new BN(4_000_000)) // Deposit 4 tokens
        .accounts({
          state: statePda,
          mint: mint,
          programTokenAccount: programTokenAccount,
          programTokenAuthority: tokenAuthPda,
          userTokenAccount: userTokenAccount,
          user: user.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      console.log("Deposited 4 tokens to program:", depositTx);
    }

    // Record initial balances
    const initialProgramBalance = parseInt(
      (await provider.connection.getTokenAccountBalance(programTokenAccount)).value.amount
    );
    const initialRecipientBalance = parseInt(
      (await provider.connection.getTokenAccountBalance(recipientTokenAccount)).value.amount
    );

    console.log("Initial program balance:", initialProgramBalance / 10 ** 6, "tokens");
    console.log("Initial recipient balance:", initialRecipientBalance / 10 ** 6, "tokens");

    // Define withdrawal amounts (3 separate withdrawals)
    const withdrawalAmounts = [
      new BN(500_000),  // 0.5 tokens
      new BN(750_000),  // 0.75 tokens
      new BN(1_250_000) // 1.25 tokens
    ];

    const totalWithdrawalAmount = withdrawalAmounts.reduce(
      (sum, amount) => sum + amount.toNumber(), 0
    );

    console.log("Will perform 3 withdrawals totaling:", totalWithdrawalAmount / 10 ** 6, "tokens");

    // Helper function to perform a single withdrawal
    async function performWithdrawal(id: number, amount: BN) {
      console.log(`\nPerforming withdrawal #${id} of ${amount.toNumber() / 10 ** 6} tokens`);

      // Create withdrawal data
      const withdrawalData = {
        id: id,
        token: mint,
        trader: recipient.publicKey,
        amount: amount.toString(),
      };

      // Sign the withdrawal with the Ethereum wallet
      console.log("Signing withdrawal data...");
      const { v, r, s } = await signWithdrawal(
        signerWallet,
        statePda,
        withdrawalData
      );

      // Find the withdrawal record account PDA
      const withdrawalAccount = PublicKey.findProgramAddressSync(
        [
          Buffer.from("withdrawal_account"),
          new BN(id / 4000).toArrayLike(Buffer, 'le', 8)
        ],
        program.programId
      )[0];

      // Execute the withdrawal transaction
      console.log("Executing withdrawal transaction...");
      const tx = await program.methods
        .withdrawToken(
          new BN(id),
          amount,
          v,
          r,
          s
        )
        .accounts({
          state: statePda,
          withdrawalRecord: withdrawalAccount,
          mint: mint,
          programTokenAccount: programTokenAccount,
          programTokenAuthority: tokenAuthPda,
          traderTokenAccount: recipientTokenAccount,
          trader: recipient.publicKey,
          payer: user.publicKey, // User is the transaction signer/payer
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([user])
        .rpc();

      console.log(`Withdrawal transaction successful:`, tx);

      // Get updated balances
      const currentProgramBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(programTokenAccount)).value.amount
      );
      const currentRecipientBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(recipientTokenAccount)).value.amount
      );

      console.log(`Program balance after withdrawal #${id}:`, currentProgramBalance / 10 ** 6, "tokens");
      console.log(`Recipient balance after withdrawal #${id}:`, currentRecipientBalance / 10 ** 6, "tokens");

      return { programBalance: currentProgramBalance, recipientBalance: currentRecipientBalance };
    }

    try {
      // Perform the 3 withdrawals in sequence
      const results = [];
      for (let i = 0; i < withdrawalAmounts.length; i++) {
        const withdrawalId = 600000 + i; // Unique IDs starting from 600000
        const result = await performWithdrawal(withdrawalId, withdrawalAmounts[i]);
        results.push(result);
      }

      // Get final balances
      const finalProgramBalance = results[results.length - 1].programBalance;
      const finalRecipientBalance = results[results.length - 1].recipientBalance;

      // Calculate and verify the expected changes
      const expectedProgramDecrease = totalWithdrawalAmount;
      const expectedRecipientIncrease = totalWithdrawalAmount;

      const actualProgramDecrease = initialProgramBalance - finalProgramBalance;
      const actualRecipientIncrease = finalRecipientBalance - initialRecipientBalance;

      console.log("\n=== Final Balance Check ===");
      console.log("Expected program decrease:", expectedProgramDecrease / 10 ** 6, "tokens");
      console.log("Actual program decrease:", actualProgramDecrease / 10 ** 6, "tokens");
      console.log("Expected recipient increase:", expectedRecipientIncrease / 10 ** 6, "tokens");
      console.log("Actual recipient increase:", actualRecipientIncrease / 10 ** 6, "tokens");

      // Verify results match expectations
      assert.equal(actualProgramDecrease, expectedProgramDecrease,
        "Program balance decrease doesn't match expected total withdrawal amount");
      assert.equal(actualRecipientIncrease, expectedRecipientIncrease,
        "Recipient balance increase doesn't match expected total withdrawal amount");

      console.log("\n✅ Multiple withdrawals test passed successfully!");
      console.log(`Total withdrawn: ${totalWithdrawalAmount / 10 ** 6} tokens in 3 transactions`);

    } catch (e) {
      console.error("Error during multiple withdrawals test:", e);
      if (e.logs) {
        console.log("Detailed error logs:", e.logs);
      }
      throw e;
    }
  });
});

// SECTION 3: Timelock tests
describe("timelock operations", () => {
  it("queue timelock operation to add new authority", async () => {
    const newAuthority = anchor.web3.Keypair.generate();
    console.log("New authority public key:", newAuthority.publicKey.toBase58());

    const state = await fetchStateAccount(program, statePda);
    // console.log("Current timelock authorities:", state.timelockAuthorities.map(a => a.toBase58()));

    // // Check if timelockAuthority is in the authorities list
    // const authorityExists = state.timelockAuthorities.some(
    //   a => a.toBase58() === timelockAuthority.publicKey.toBase58()
    // );

    // Queue the timelock operation to add new authority
    const operationData = new PublicKey(newAuthority.publicKey).toBytes();

    await program.methods
      .queueOperation(new BN(4), Buffer.from(operationData)) // 4 = Add timelock authority
      .accounts({
        state: statePda,
        authority: timelockAuthority.publicKey,
      })
      .signers([timelockAuthority])
      .rpc();

    // Verify operation was queued
    const stateAfterQueue = await fetchStateAccount(program, statePda);
    console.log(`Pending operations: ${stateAfterQueue.pendingOperations.length}`);
    console.log(`First pending operation type: ${stateAfterQueue.pendingOperations[0]?.operationType}`);

    // Attempt to execute the operation immediately - this should fail
    try {
      await program.methods
        .executeOperation(new BN(0))
        .accounts({
          state: statePda,
          authority: timelockAuthority.publicKey,
        })
        .signers([timelockAuthority])
        .rpc();
      assert.fail("Immediate execution should have failed");
    } catch (e) {
      console.log("Immediate execution failed as expected with error:", e.message);
      assert.ok(e.message.includes("TimelockDelayNotMet"), "Error should be TimelockDelayNotMet");
    }

    await waitForTimelock(state);
    // Execute the operation
    await program.methods
      .executeOperation(new BN(0))
      .accounts({
        state: statePda,
        authority: timelockAuthority.publicKey,
      })
      .signers([timelockAuthority])
      .rpc();

    // Verify authority was added
    const stateAfterExecution = await fetchStateAccount(program, statePda);
    console.log("Authorities after execution:", stateAfterExecution.timelockAuthorities.map(a => a.toBase58()));

    // Verify the new authority was added
    const newAuthorityAdded = stateAfterExecution.timelockAuthorities.some(
      a => a.toBase58() === newAuthority.publicKey.toBase58()
    );

    expect(newAuthorityAdded).to.be.true;
  });

  it("queue timelock operation to update withdrawal signer", async () => {
    const newWithdrawalSigner = generateEthereumAddress();
    console.log("New withdrawal signer:", newWithdrawalSigner.toString('hex'));

    // Fetch the state account to get current withdrawal signer
    const state = await fetchStateAccount(program, statePda);
    console.log("Current withdrawal signer:", Buffer.from(state.withdrawalSigner).toString('hex'));

    // Queue the timelock operation to update withdrawal signer
    await program.methods
      .queueOperation(new BN(2), newWithdrawalSigner) // 2 = Change signer
      .accounts({
        state: statePda,
        authority: timelockAuthority.publicKey,
      })
      .signers([timelockAuthority])
      .rpc();

    // Verify operation was queued
    const stateAfterQueue = await fetchStateAccount(program, statePda);
    console.log(`Pending operations: ${stateAfterQueue.pendingOperations.length}`);

    // Find the index of the operation we just queued
    const operationIndex = stateAfterQueue.pendingOperations.findIndex(op => op.operationType === 2);
    console.log(`Found operation at index: ${operationIndex}`);

    if (operationIndex === -1) {
      throw new Error("Could not find the withdrawal signer operation in pending operations");
    }

    await waitForTimelock(state);
    // Execute the operation
    await program.methods
      .executeOperation(new BN(operationIndex))
      .accounts({
        state: statePda,
        authority: timelockAuthority.publicKey,
      })
      .signers([timelockAuthority])
      .rpc();

    const stateAfterExecution = await fetchStateAccount(program, statePda);
    console.log("Withdrawal signer after execution:", Buffer.from(stateAfterExecution.withdrawalSigner).toString('hex'));

    // Verify the new withdrawal signer was set
    expect(Buffer.from(stateAfterExecution.withdrawalSigner).toString('hex'))
      .to.equal(newWithdrawalSigner.toString('hex'));
  });

  it("Fails when unauthorized account attempts to queue withdrawal signer update", async () => {
    console.log("\n=== Testing unauthorized withdrawal signer update attempt ===");

    // Create an unauthorized account
    const unauthorizedAccount = Keypair.generate();
    console.log("Unauthorized account:", unauthorizedAccount.publicKey.toString());

    // Fund the unauthorized account
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        unauthorizedAccount.publicKey,
        1 * LAMPORTS_PER_SOL
      )
    );

    // Generate a new withdrawal signer
    const newWithdrawalSigner = generateEthereumAddress();
    console.log("Attempting to set new withdrawal signer:", newWithdrawalSigner.toString('hex'));

    try {
      // Attempt to queue the operation with unauthorized account
      await program.methods
        .queueOperation(new BN(2), newWithdrawalSigner) // 2 = Change signer
        .accounts({
          state: statePda,
          authority: unauthorizedAccount.publicKey, // Using unauthorized account
        })
        .signers([unauthorizedAccount])
        .rpc();

      // If we get here, the test failed because the unauthorized operation succeeded
      assert.fail("Unauthorized account should not be able to queue withdrawal signer update");
    } catch (e) {
      console.log("Operation failed as expected with error:", e.message);
      assert.ok(
        e.message.includes("Unauthorized access"),
        "Error should indicate unauthorized access"
      );
    }

    // Verify the withdrawal signer hasn't changed
    const state = await fetchStateAccount(program, statePda);
    console.log("Current withdrawal signer:", Buffer.from(state.withdrawalSigner).toString('hex'));

    // Verify no new operations were queued
    console.log("Number of pending operations:", state.pendingOperations.length);
    expect(state.pendingOperations.length).to.equal(0);
  });

  it("Queues a timelock operation to change the timelock delay", async () => {
    console.log("\n=== Testing timelock operations: Change Timelock Delay ===");
    console.log("Using timelock authority:", timelockAuthority.publicKey.toString());

    // Prepare data for changing timelock delay to 20 seconds
    const newDelay = 20;
    const delayBytes = new BN(newDelay).toArrayLike(Buffer, 'le', 8);

    try {
      // Queue the operation
      const tx = await program.methods
        .queueOperation(
          new BN(3), // 3 = Set timelock delay operation type
          Buffer.from(delayBytes)
        )
        .accounts({
          state: statePda,
          authority: timelockAuthority.publicKey,
        })
        .signers([timelockAuthority])
        .rpc();

      console.log("Successfully queued change timelock delay operation:", tx);

      // Get the updated state to see the pending operations
      const state = await fetchStateAccount(program, statePda);
      console.log("State account exists with size:", state.pendingOperations.length, "pending operations");
      console.log("Operation has been queued successfully");

      // Find the index of the operation we just queued
      const operationIndex = state.pendingOperations.findIndex(op => op.operationType === 3);
      console.log(`Found operation at index: ${operationIndex}`);

      if (operationIndex === -1) {
        throw new Error("Could not find the timelock delay operation in pending operations");
      }

      // Wait for the timelock to expire
      await waitForTimelock(state);

      // Execute the operation
      await program.methods
        .executeOperation(new BN(operationIndex))
        .accounts({
          state: statePda,
          authority: timelockAuthority.publicKey,
        })
        .signers([timelockAuthority])
        .rpc();

      // Verify the timelock delay was changed
      const stateAfterExecution = await fetchStateAccount(program, statePda);
      console.log("Timelock delay after execution:", stateAfterExecution.timelockDelay.toNumber());
      expect(stateAfterExecution.timelockDelay.toNumber()).to.equal(newDelay);

    } catch (e) {
      console.error("Error queueing timelock delay operation:", e);
      throw e;
    }
  });

});
